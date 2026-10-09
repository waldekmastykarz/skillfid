import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { AsyncLimiter, limitRunner } from './concurrency.js';
import { CopilotSdkRunError, CopilotSdkRunner } from './copilot-sdk.js';
import { corpusRevision, loadCorpus, splitDocument, splitSection } from './corpus.js';
import {
  assertCompleteCoverage, calibrateQuestion, DATASET_PIPELINE_VERSION, DatasetBuildError, deduplicateEvidence, formatCount, IMPORTANCE_PROFILES,
  JUDGE_CONSENSUS_POLICY_VERSION, processWorkRoot, publishDataset, waitMessage,
} from './dataset-core.js';
import { countCalls, createDashboard, createSectionReporter, datasetMetrics, datasetProgress, recordCalls } from './dataset-progress.js';
import { EXIT_CODES, UsageError } from './errors.js';
import { writeJson } from './files.js';
import { stableStringify } from './json.js';
import { buildInventoryPrompt, parseInventoryResponse } from './inventory.js';
import { auditInventory, ConvergenceError, convergeInventory } from './inventory-passes.js';
import { operationId, OperationJournal } from './journal.js';
import { buildQuestionPrompt, parseQuestionResponse } from './questions.js';
import { runStructured } from './structured.js';

// A section that still fails to settle is split into halves at most this many times before the build gives up on it.
const MAX_SPLIT_DEPTH = 2;
const SPLITTABLE_CODES = new Set(['INVENTORY_NOT_CONVERGED', 'AUDIT_NOT_CONVERGED']);

export function resolveBuildSettings(options = {}) {
  const defined = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
  const settings = {
    model: 'gpt-5.6-sol', judgeModel: undefined, reasoningEffort: 'medium',
    timeoutSeconds: 600, timeoutRetries: 1, maxAttempts: 3, cleanResidualPasses: 1, concurrency: 10, resume: true,
    maxResidualPasses: 3, maxAuditPasses: 3, maxGenerationAttempts: 8, escalate: true,
    maxSectionChars: 12_000, minSectionChars: 1500, importance: IMPORTANCE_PROFILES.full, include: [], exclude: [], ...defined,
  };
  settings.judgeModel ??= settings.model;
  const tiers = IMPORTANCE_PROFILES.full.filter((tier) => settings.importance.includes(tier));
  if (!tiers.length || tiers.length !== new Set(settings.importance).size) throw new UsageError(`Importance tiers must be a non-empty subset of ${IMPORTANCE_PROFILES.full.join(', ')}`);
  settings.importance = tiers;
  return settings;
}

// Result-affecting settings identify the operation; budgets and runtime knobs (passes, timeouts, concurrency) do not,
// so raising a budget resumes the same operation instead of restarting it.
export function datasetScope(settings) {
  return {
    pipelineVersion: DATASET_PIPELINE_VERSION, judgeConsensusPolicyVersion: JUDGE_CONSENSUS_POLICY_VERSION,
    model: settings.model, judgeModel: settings.judgeModel, reasoningEffort: settings.reasoningEffort,
    cleanResidualPasses: settings.cleanResidualPasses, importance: settings.importance,
  };
}

export async function loadSections(corpusPath, settings) {
  const documents = await loadCorpus(corpusPath, { include: settings.include, exclude: settings.exclude });
  const sections = documents.flatMap((document) => splitDocument(document, settings.maxSectionChars, settings.minSectionChars));
  if (!sections.length) throw new DatasetBuildError('Corpus has no non-empty sections');
  return { documents, sections };
}

export async function buildDataset({ corpusPath, outputRoot = 'datasets', workRoot = '.work/dataset', options = {}, runner, judgeRunner, progress }) {
  const settings = resolveBuildSettings(options);
  progress?.({ type: 'start', workflow: 'dataset', title: 'Building dataset', current: 'Reading Markdown corpus', progress: { done: 0, total: 0, label: 'knowledge items covered' } });
  const { documents, sections } = await loadSections(corpusPath, settings);
  const documentById = new Map(documents.map((document) => [document.documentId, document]));
  const dashboard = createDashboard({ sections: sections.length, documents: documents.length, concurrency: settings.concurrency });
  progress?.({ type: 'update', workflow: 'dataset', title: 'Building dataset', current: `Preparing ${formatCount(sections.length, 'section')}`, progress: datasetProgress(dashboard), metrics: datasetMetrics(dashboard) });
  const generatedRunner = !runner;
  const generatedJudge = !runner && !judgeRunner;
  const limiter = new AsyncLimiter(settings.concurrency);
  // Admitting only as many sections as call slots finishes sections steadily instead of interleaving every section's stages.
  const sectionLimiter = new AsyncLimiter(settings.concurrency);
  const runWork = processWorkRoot(workRoot, 'build');
  const baseRunner = runner ?? new CopilotSdkRunner({ model: settings.model, reasoningEffort: settings.reasoningEffort, timeoutSeconds: settings.timeoutSeconds, maxTimeoutRetries: settings.timeoutRetries, isolatedHome: path.join(runWork, 'home', 'subject'), progress });
  const baseJudge = judgeRunner ?? runner ?? new CopilotSdkRunner({ model: settings.judgeModel, reasoningEffort: settings.reasoningEffort, timeoutSeconds: settings.timeoutSeconds, maxTimeoutRetries: settings.timeoutRetries, isolatedHome: path.join(runWork, 'home', 'judge'), progress });
  const activeRunner = limitRunner(baseRunner, limiter);
  const activeJudge = baseJudge === baseRunner ? activeRunner : limitRunner(baseJudge, limiter);
  const scope = datasetScope(settings);
  const operationInputs = { corpusRevision: corpusRevision(documents), ...scope, maxSectionChars: settings.maxSectionChars, minSectionChars: settings.minSectionChars };
  const baseOperationId = operationId('dataset', operationInputs);
  let journal;
  let activeOperationId = baseOperationId;
  try {
    const copilotVersion = await activeRunner.version();
    const journalPath = path.resolve(workRoot, 'operations.sqlite');
    journal = await OperationJournal.open(journalPath);
    activeOperationId = settings.resume ? journal.findResumableOperation('dataset', operationInputs)?.operationId ?? baseOperationId : `${baseOperationId}_${randomUUID().slice(0, 8)}`;
    journal.startOperation({ operationId: activeOperationId, kind: 'dataset', inputs: operationInputs, cacheScope: settings.resume ? scope : undefined, config: { concurrency: settings.concurrency, timeoutRetries: settings.timeoutRetries, fresh: !settings.resume, maxResidualPasses: settings.maxResidualPasses, maxAuditPasses: settings.maxAuditPasses, sections: sections.length } });
    journal.acquireOperationLock(activeOperationId);
    progress?.({ type: 'operation', workflow: 'dataset', message: `Dataset operation ${activeOperationId}; concurrency ${settings.concurrency}; journal ${journalPath}`, details: { operationId: activeOperationId, concurrency: settings.concurrency, journalPath, sections: sections.length } });
    const workspace = path.join(runWork, 'generation');
    await mkdir(workspace, { recursive: true });

    let systemicFailures = 0;
    let aborted = false;
    const sectionTasks = sections.map(async (section, sectionIndex) => {
      const document = documentById.get(section.documentId);
      const reporter = createSectionReporter({ progress, dashboard, section });
      const job = journal.ensureJob({ operationId: activeOperationId, stage: 'section', entityId: section.sectionId, label: section.label, inputs: { section, documentRevision: document.revision, pipelineVersion: DATASET_PIPELINE_VERSION } });
      if (job.status === 'completed') {
        dashboard.completed += 1; dashboard.resumed += 1;
        updateReusedSection(dashboard, section, job.output);
        progress?.({ type: 'update', workflow: 'dataset', current: `Reusing ${section.label}${job.reusedFrom ? ' (cached from an earlier operation)' : ''}`, progress: datasetProgress(dashboard), metrics: datasetMetrics(dashboard) });
        return { section, output: job.output };
      }
      dashboard.estimate.sections.set(section.sectionId, { chars: section.content.length, calls: 0, items: undefined, questions: 0, completed: false });
      return sectionLimiter.run(async () => {
        if (aborted) return { section, skipped: true };
        dashboard.running += 1;
        const transcript = [];
        try {
          const { output } = await journal.executeJob(job, () => processSection({
            section, document, workspace: path.join(workspace, section.sectionId), settings, reporter,
            runner: recordCalls(countCalls(activeRunner, () => reporter.call()), transcript, 'subject'), judgeRunner: recordCalls(countCalls(activeJudge, () => reporter.call()), transcript, 'judge'), depth: 0,
          }), { onWait: (wait) => progress?.({ type: 'update', workflow: 'dataset', current: waitMessage(wait) }) });
          Object.assign(dashboard.estimate.sections.get(section.sectionId), { items: output.items.length, completed: true });
          dashboard.running -= 1; dashboard.completed += 1;
          reporter.finish();
          progress?.({ type: 'update', workflow: 'dataset', current: `Finalized ${section.label}`, progress: datasetProgress(dashboard), metrics: datasetMetrics(dashboard) });
          return { section, output };
        } catch (error) {
          dashboard.running -= 1; dashboard.failed += 1;
          reporter.finish();
          if (error instanceof CopilotSdkRunError) {
            systemicFailures += 1;
            if (systemicFailures >= Math.max(3, settings.concurrency) && dashboard.completed === dashboard.resumed) aborted = true;
          }
          const transcriptPath = await writeTranscript({ workRoot, operationId: activeOperationId, section, error, transcript });
          progress?.({ type: 'error', workflow: 'dataset', message: `Section failed: ${section.label}: ${error.message}`, progress: datasetProgress(dashboard), metrics: datasetMetrics(dashboard) });
          return { section, failure: { ...failureRecord(section, error, sectionIndex), transcriptPath } };
        }
      });
    });
    const settled = await Promise.allSettled(sectionTasks);
    const outcomes = settled.map((result, index) => result.status === 'fulfilled' ? result.value : { section: sections[index], failure: failureRecord(sections[index], result.reason, index) });
    const failures = outcomes.filter((outcome) => outcome.failure).map((outcome) => outcome.failure);
    const skipped = outcomes.filter((outcome) => outcome.skipped).length;
    if (failures.length || skipped) throw await sectionFailuresError({ workRoot, operationId: activeOperationId, failures, skipped, total: sections.length, aborted });

    const allItems = [];
    const allEvidence = [];
    const allQuestions = [];
    const verifications = {};
    const calibrations = {};
    const audits = [];
    let excludedItems = 0;
    for (const { output } of outcomes) {
      allItems.push(...output.items);
      allEvidence.push(...output.evidence);
      allQuestions.push(...output.questions);
      audits.push(output.audit);
      excludedItems += output.excludedItems ?? 0;
      Object.assign(verifications, output.verifications);
      Object.assign(calibrations, output.calibrations);
    }
    assertCompleteCoverage(allItems, allQuestions);
    journal.assertAllJobsCompleted(activeOperationId);
    const finalCounts = journal.jobCounts(activeOperationId);
    progress?.({ type: 'checkpoint', workflow: 'dataset', current: 'Publishing immutable dataset', progress: datasetProgress(dashboard), metrics: datasetMetrics(dashboard), details: { jobs: finalCounts } });
    const destination = await publishDataset({ outputRoot, documents, sections, items: allItems, evidence: deduplicateEvidence(allEvidence), questions: allQuestions, verifications, calibrations, audits, options: settings, copilotVersion, scope: { importance: settings.importance, excludedItems } });
    journal.completeOperation(activeOperationId, destination);
    const tiers = settings.importance.length < IMPORTANCE_PROFILES.full.length ? `Importance tiers: ${settings.importance.join(', ')}` : 'Coverage 100%, calibration passed';
    progress?.({ type: 'complete', workflow: 'dataset', title: 'Dataset built', summary: [`${formatCount(documents.length, 'document')}, ${formatCount(sections.length, 'section')}${dashboard.resumed ? ` (${dashboard.resumed} reused)` : ''}`, `${formatCount(allItems.length, 'knowledge item')}, ${formatCount(allQuestions.length, 'question')}`, tiers], details: { destination, operationId: activeOperationId } });
    return destination;
  } catch (error) {
    journal?.failOperation(activeOperationId, error);
    throw error;
  } finally {
    journal?.close();
    if (generatedRunner) await baseRunner.close();
    if (generatedJudge) await baseJudge.close();
    await rm(runWork, { recursive: true, force: true });
  }
}

function updateReusedSection(dashboard, section, output) {
  dashboard.sectionItems.set(section.sectionId, output.items.length);
  dashboard.sectionCovered.set(section.sectionId, output.items.length);
  dashboard.sectionGenerated.set(section.sectionId, output.questions.length);
  dashboard.sectionCalibrated.set(section.sectionId, output.questions.length);
}

function failureRecord(section, error, index) {
  return { sectionId: section.sectionId, label: section.label, index: index + 1, code: error.code ?? 'ERROR', message: error.message, details: error.details };
}

// The first line describes the failure and the section; every later line is one Copilot call with its prompt and answer.
async function writeTranscript({ workRoot, operationId: id, section, error, transcript }) {
  const transcriptPath = path.resolve(workRoot, 'failures', id, `${section.sectionId.replaceAll(/[^\w.-]/g, '_')}.jsonl`);
  try {
    await mkdir(path.dirname(transcriptPath), { recursive: true });
    const header = { sectionId: section.sectionId, label: section.label, error: error.message, code: error.code ?? 'ERROR', details: error.details, calls: transcript.length };
    await writeFile(transcriptPath, [header, ...transcript].map((line) => stableStringify(line)).join('\n') + '\n', 'utf8');
    return transcriptPath;
  } catch { return undefined; }
}

async function sectionFailuresError({ workRoot, operationId: id, failures, skipped, total, aborted }) {
  const reportPath = path.resolve(workRoot, 'failures', `${id}.json`);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeJson(reportPath, { operationId: id, createdAt: new Date().toISOString(), total, failed: failures.length, skipped, failures });
  const lines = failures.slice(0, 10).map((failure, index) => `  ${index + 1}. ${failure.label}\n     ${failure.message}${failure.details?.history ? `\n     passes (added per pass): ${failure.details.history.filter((pass) => pass.kind !== 'initial').map((pass) => pass.added).join(', ') || 'none'}` : ''}${failure.transcriptPath ? `\n     transcript: ${failure.transcriptPath}` : ''}`);
  if (failures.length > lines.length) lines.push(`  … and ${failures.length - lines.length} more`);
  const done = total - failures.length - skipped;
  const headline = aborted
    ? `Stopped early: ${failures.length} Copilot calls failed before any section finished (${skipped} sections not started). Check authentication and connectivity.`
    : `${failures.length} of ${total} sections failed; the other ${done} are saved and will be reused.`;
  return new DatasetBuildError(`${headline}\n${lines.join('\n')}\nFailure details: ${reportPath}`, {
    code: aborted ? 'RUNNER_UNAVAILABLE' : 'SECTIONS_FAILED',
    exitCode: aborted ? EXIT_CODES.failure : EXIT_CODES.incomplete,
    remedy: aborted ? 'Fix the Copilot connection, then re-run the same command; nothing completed is lost.' : 'Re-run the same command: finished sections are reused. Raise --max-residual-passes, lower --max-section-chars, or edit the failing section.',
    details: { operationId: id, total, failed: failures.length, skipped, reportPath, failures },
  });
}

async function processSection({ section, document, runner, judgeRunner, workspace, settings, reporter, depth }) {
  await mkdir(workspace, { recursive: true });
  const extract = (existingItems, existingEvidence) => extractInventory(runner, workspace, section, document, settings, existingItems, existingEvidence);
  try {
    reporter.stage('Inventorying knowledge');
    const converged = await convergeInventory({ extract, label: reporter.label, settings, reporter });
    const audited = await auditInventory({ extract, inventory: converged, label: reporter.label, settings, reporter });
    return await finishSection({ section, converged, audited, runner, judgeRunner, workspace, settings, reporter, document });
  } catch (error) {
    if (settings.escalate && depth < MAX_SPLIT_DEPTH && error instanceof ConvergenceError && SPLITTABLE_CODES.has(error.code)) {
      const parts = splitSection(section, document);
      if (parts) {
        reporter.warn(`${reporter.label} did not converge; splitting it into two parts`);
        reporter.forget();
        const outputs = await Promise.all(parts.map((part, index) => processSection({ section: part, document, runner, judgeRunner, workspace: path.join(workspace, `part-${index + 1}`), settings, reporter: reporter.part(part), depth: depth + 1 })));
        return mergeParts(outputs, section);
      }
    }
    throw error;
  }
}

async function finishSection({ section, converged, audited, runner, judgeRunner, workspace, settings, reporter, document }) {
  const selected = new Set(settings.importance);
  const items = audited.items.filter((item) => selected.has(item.importance));
  const evidenceIds = new Set(items.flatMap((item) => item.evidenceIds));
  const evidence = deduplicateEvidence(audited.evidence.filter((record) => evidenceIds.has(record.evidenceId)));
  reporter.stage('Preparing questions');
  reporter.results({ items: items.length, covered: 0, generated: 0, calibrated: 0 });
  const sectionAudit = { sectionId: section.sectionId, passed: true, missingKnowledgeIds: [], recoveredKnowledgeIds: audited.recoveredKnowledgeIds, reason: audited.audit.reason, passes: [...converged.history, ...audited.history] };
  let generated = { questions: [], verifications: {}, calibrations: {} };
  if (items.length) {
    generated = await generateVerifiedQuestions({ runner, judgeRunner, workspace, inventory: { items, evidence }, settings, reporter, source: document.content });
  }
  return { items, evidence, audit: sectionAudit, excludedItems: audited.items.length - items.length, ...generated };
}

function mergeParts(outputs, section) {
  return {
    items: outputs.flatMap((output) => output.items.map((item) => ({ ...item, sectionId: section.sectionId }))),
    evidence: deduplicateEvidence(outputs.flatMap((output) => output.evidence.map((record) => ({ ...record, sectionId: section.sectionId })))),
    audit: {
      sectionId: section.sectionId, passed: true, missingKnowledgeIds: [], split: true,
      recoveredKnowledgeIds: outputs.flatMap((output) => output.audit.recoveredKnowledgeIds),
      reason: outputs.map((output) => output.audit.reason).join(' '),
      passes: outputs.flatMap((output) => output.audit.passes ?? []),
    },
    excludedItems: outputs.reduce((sum, output) => sum + (output.excludedItems ?? 0), 0),
    questions: outputs.flatMap((output) => output.questions),
    verifications: Object.assign({}, ...outputs.map((output) => output.verifications)),
    calibrations: Object.assign({}, ...outputs.map((output) => output.calibrations)),
  };
}

function extractInventory(runner, workspace, section, document, settings, existingItems, existingEvidence) {
  return runStructured({ runner, workspace, prompt: buildInventoryPrompt(section, existingItems, existingEvidence), validator: (response) => parseInventoryResponse(response, { section, document }), maxAttempts: settings.maxAttempts });
}

async function generateVerifiedQuestions({ runner, judgeRunner, workspace, inventory, settings, reporter, source }) {
  const retained = [];
  const verifications = {};
  const calibrations = {};
  let pendingItems = inventory.items;
  let feedback = '';
  let generatedCount = 0;
  let calibratedCount = 0;
  let generationAttempt = 0;
  while (pendingItems.length) {
    generationAttempt += 1;
    const pendingEvidenceIds = new Set(pendingItems.flatMap((item) => item.evidenceIds));
    const basePrompt = buildQuestionPrompt(pendingItems, inventory.evidence.filter((record) => pendingEvidenceIds.has(record.evidenceId)));
    const prompt = feedback ? [basePrompt, '', 'The previous question set failed independent verification:', feedback, 'Generate replacement questions for all supplied knowledge IDs.', 'Correct every reported issue without changing the source facts.'].join('\n') : basePrompt;
    reporter.stage('Generating questions');
    const questions = await runStructured({ runner, workspace, prompt, validator: (response) => parseQuestionResponse(response, pendingItems), maxAttempts: settings.maxAttempts });
    generatedCount += questions.length;
    reporter.results({ items: inventory.items.length, generated: generatedCount, calibrated: calibratedCount });
    reporter.stage('Calibrating questions');
    const outcomes = await Promise.all(questions.map(async (question, questionIndex) => {
      const questionWorkspace = path.join(workspace, 'questions', question.testId);
      await mkdir(questionWorkspace, { recursive: true });
      reporter.detail(`Calibrating question ${questionIndex + 1} of ${questions.length}`);
      const calibration = await calibrateQuestion({ runner, judgeRunner, workspace: questionWorkspace, question, source, maxAttempts: settings.maxAttempts, generationAttempt });
      calibratedCount += 1;
      reporter.results({ items: inventory.items.length, generated: generatedCount, calibrated: calibratedCount });
      if (calibration.judgeConsensus.verdict !== 'pass' || calibration.score < 1 || !calibration.verification.passed || !calibration.integrity.passed) {
        return { question, failure: `Question ${question.testId}: judge consensus ${calibration.judgeConsensus.verdict} (${calibration.judgeConsensus.passVotes}/${calibration.judgeConsensus.totalJudgments} pass); oracle calibration scored ${calibration.score.toFixed(3)}; verification passed: ${calibration.verification.passed}; integrity passed: ${calibration.integrity.passed}. ${calibration.verification.reason} ${calibration.integrity.rationale} ${calibration.criterionResults.filter((item) => item.score < 1).map((item) => item.rationale).join(' ')}` };
      }
      return { question, verification: calibration.verification, calibration };
    }));
    const failures = [];
    for (const outcome of outcomes) {
      if (outcome.failure) { failures.push(outcome.failure); continue; }
      const { question, verification, calibration } = outcome;
      retained.push(question);
      verifications[question.testId] = verification;
      calibrations[question.testId] = calibration;
    }
    const coveredIds = new Set(retained.flatMap((question) => question.rubric.flatMap((criterion) => criterion.knowledgeItemIds)));
    reporter.results({ items: inventory.items.length, covered: coveredIds.size, generated: generatedCount, calibrated: calibratedCount });
    pendingItems = inventory.items.filter((item) => !coveredIds.has(item.knowledgeId));
    if (!pendingItems.length) return { questions: retained, verifications, calibrations };
    feedback = failures.join('\n');
    if (generationAttempt >= settings.maxGenerationAttempts) {
      throw new ConvergenceError(`Question generation did not converge for ${reporter.label} after ${generationAttempt} attempts; ${pendingItems.length} knowledge items still have no question that passes calibration`, {
        kind: 'questions',
        remedy: 'Finished sections are cached. Raise --max-generation-attempts, or review the unresolved items in the failure details; the source text may be ambiguous or contradictory.',
        details: { label: reporter.label, attempts: generationAttempt, unresolved: pendingItems.map((item) => ({ knowledgeId: item.knowledgeId, statement: item.statement })), lastFailures: failures.slice(0, 5) },
      });
    }
    reporter.stage(`Regenerating ${formatCount(pendingItems.length, 'unresolved item')} (attempt ${generationAttempt + 1})`);
  }
  return { questions: retained, verifications, calibrations };
}
