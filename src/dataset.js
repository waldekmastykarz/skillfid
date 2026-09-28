import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { buildCalibrationPrompt, parseCalibrationResponse } from './calibration.js';
import { AsyncLimiter, limitRunner } from './concurrency.js';
import { CopilotSdkRunner } from './copilot-sdk.js';
import { corpusRevision, loadCorpus, splitDocument } from './corpus.js';
import { readJson, readJsonl, writeJson, writeJsonl } from './files.js';
import { buildInventoryPrompt, parseInventoryResponse } from './inventory.js';
import { stableStringify } from './json.js';
import { operationId, OperationJournal } from './journal.js';
import { ORACLE_PROMPT_VERSION, oraclePrompt } from './prompts.js';
import { buildQuestionPrompt, parseQuestionResponse } from './questions.js';
import { runStructured } from './structured.js';

export const DATASET_SCHEMA_VERSION = 6;
const DATASET_PIPELINE_VERSION = '0.4.1';
const RECALIBRATION_PIPELINE_VERSION = '0.5.7';
const JUDGE_CONSENSUS_POLICY_VERSION = '1';
const INITIAL_JUDGMENTS = 3;
const DISAGREEMENT_JUDGMENTS = 2;
const SUPERMAJORITY_VOTES = 4;
export class DatasetBuildError extends Error {}

export async function recalibrateDataset({ datasetPath, outputRoot = 'datasets', workRoot = '.work/recalibrate', options = {}, runner, judgeRunner, progress }) {
  const settings = {
    model: undefined, judgeModel: undefined, reasoningEffort: undefined, timeoutSeconds: 600,
    timeoutRetries: 1, maxAttempts: 3, concurrency: 10, resume: true, ...options,
  };
  progress?.({ type: 'start', workflow: 'recalibration', title: 'Recalibrating dataset', current: 'Verifying source dataset · extraction will not run' });
  const dataset = await loadDataset(datasetPath);
  settings.model ??= dataset.manifest.calibration.model;
  settings.judgeModel ??= dataset.manifest.calibration.judgeModel;
  settings.reasoningEffort ??= dataset.manifest.calibration.reasoningEffort;
  const sourceRoot = path.resolve(datasetPath);
  const [documents, knowledge, evidence, coverage, audit, verifications] = await Promise.all([
    readJsonl(path.join(sourceRoot, 'documents.jsonl')),
    readJsonl(path.join(sourceRoot, 'knowledge.jsonl')),
    readJsonl(path.join(sourceRoot, 'evidence.jsonl')),
    readJson(path.join(sourceRoot, 'coverage.json')),
    readJson(path.join(sourceRoot, 'audit.json')),
    readJson(path.join(sourceRoot, 'verifications.json')),
  ]);
  const generatedRunner = !runner;
  const generatedJudge = !runner && !judgeRunner;
  const runWork = processWorkRoot(workRoot, 'recalibration');
  const baseRunner = runner ?? new CopilotSdkRunner({ model: settings.model, reasoningEffort: settings.reasoningEffort, timeoutSeconds: settings.timeoutSeconds, maxTimeoutRetries: settings.timeoutRetries, isolatedHome: path.join(runWork, 'home', 'subject'), progress });
  const baseJudge = judgeRunner ?? runner ?? new CopilotSdkRunner({ model: settings.judgeModel, reasoningEffort: settings.reasoningEffort, timeoutSeconds: settings.timeoutSeconds, maxTimeoutRetries: settings.timeoutRetries, isolatedHome: path.join(runWork, 'home', 'judge'), progress });
  const copilotVersion = await baseRunner.version();
  progress?.({ type: 'update', workflow: 'recalibration', current: `Running oracle and judge · Copilot CLI ${dataset.manifest.copilotCliVersion} → ${copilotVersion}`, progress: { done: 0, total: dataset.questions.length, label: 'existing questions' } });
  const operationInputs = { sourceDatasetId: dataset.datasetId, pipelineVersion: RECALIBRATION_PIPELINE_VERSION, oraclePromptVersion: ORACLE_PROMPT_VERSION, judgeConsensusPolicyVersion: JUDGE_CONSENSUS_POLICY_VERSION, copilotVersion, model: settings.model, judgeModel: settings.judgeModel, reasoningEffort: settings.reasoningEffort, maxAttempts: settings.maxAttempts };
  const baseOperationId = operationId('recalibration', operationInputs);
  const journalPath = path.resolve(workRoot, 'operations.sqlite');
  const journal = await OperationJournal.open(journalPath);
  const activeOperationId = settings.resume ? journal.findResumableOperation('recalibration', operationInputs)?.operationId ?? baseOperationId : `${baseOperationId}_${randomUUID().slice(0, 8)}`;
  journal.startOperation({ operationId: activeOperationId, kind: 'recalibration', inputs: operationInputs, config: { concurrency: settings.concurrency, timeoutRetries: settings.timeoutRetries, fresh: !settings.resume } });
  progress?.({ type: 'operation', workflow: 'recalibration', message: `Recalibration operation ${activeOperationId}; concurrency ${settings.concurrency}; journal ${journalPath}`, details: { operationId: activeOperationId, concurrency: settings.concurrency, journalPath } });
  const evidenceById = new Map(evidence.map((item) => [item.evidenceId, item]));
  const documentById = new Map(documents.map((item) => [item.documentId, item.content]));
  const previousCalibration = new Map(dataset.calibrations.map((item) => [item.testId, item]));
  const limiter = new AsyncLimiter(settings.concurrency);
  let completed = 0;
  try {
    const tasks = dataset.questions.map((question) => limiter.run(async () => {
      const documentIds = [...new Set(question.evidenceIds.map((id) => evidenceById.get(id).documentId))].sort();
      const sources = documentIds.map((id) => documentById.get(id));
      const job = journal.ensureJob({ operationId: activeOperationId, stage: 'calibration', entityId: question.testId, inputs: { question, sources, model: settings.model, judgeModel: settings.judgeModel, reasoningEffort: settings.reasoningEffort, pipelineVersion: RECALIBRATION_PIPELINE_VERSION } });
      if (job.status === 'completed') {
        completed += 1;
        progress?.({ type: 'update', workflow: 'recalibration', current: 'Restoring completed calibration from this operation', progress: { done: completed, total: dataset.questions.length, label: 'existing questions' } });
        return job.output;
      }
      const workerId = randomUUID();
      const claimedJob = journal.claimJob(job.jobId, workerId);
      if (!claimedJob) throw new DatasetBuildError(`Could not claim calibration job ${question.testId}`);
      try {
        const workspace = path.join(runWork, 'questions', question.testId);
        await mkdir(workspace, { recursive: true });
        const calibration = await recalibrateQuestion({ runner: baseRunner, judgeRunner: baseJudge, workspace, question, sources, maxAttempts: settings.maxAttempts, generationAttempt: previousCalibration.get(question.testId)?.generationAttempt ?? 1, oracleAttempt: claimedJob.attempts });
        const output = { ...calibration, runtime: { copilotCliVersion: copilotVersion, model: settings.model, judgeModel: settings.judgeModel, reasoningEffort: settings.reasoningEffort, oraclePromptVersion: ORACLE_PROMPT_VERSION } };
        if (output.judgeConsensus?.verdict !== 'pass' || output.score !== 1 || output.integrity?.passed !== true) {
          const failedCriteria = output.criterionResults.filter((result) => result.score !== 1).map((result) => result.criterionIndex);
          const integrity = Object.fromEntries(['directlyEntailed', 'contradictionChecked', 'qualificationsIncluded', 'authorityResolved', 'proxyAnswer', 'passed'].map((field) => [field, output.integrity?.[field]]));
          const failedRationales = output.criterionResults.filter((result) => result.score !== 1).map((result) => `${result.criterionIndex}:${result.rationale}`);
          throw new DatasetBuildError(`Question ${question.testId} did not retain stable perfect oracle calibration: consensus=${output.judgeConsensus?.verdict}; votes=${output.judgeConsensus?.passVotes}/${output.judgeConsensus?.totalJudgments}; score=${output.score}; failedCriteria=${failedCriteria.join(',') || 'none'}; criterionRationales=${stableStringify(failedRationales)}; integrity=${stableStringify(integrity)}; integrityRationale=${JSON.stringify(output.integrity?.rationale)}`);
        }
        journal.completeJob(job.jobId, workerId, output);
        completed += 1;
        progress?.({ type: 'update', workflow: 'recalibration', current: 'Checking existing questions against the new runtime', progress: { done: completed, total: dataset.questions.length, label: 'existing questions' } });
        return output;
      } catch (error) {
        journal.failJob(job.jobId, workerId, error);
        throw error;
      }
    }));
    const calibrations = await settleAll(tasks);
    journal.assertAllJobsCompleted(activeOperationId);
    const destination = await publishDataset({
      outputRoot, documents, sections: Array.from({ length: coverage.sections }), items: knowledge, evidence,
      questions: dataset.questions, verifications, calibrations: Object.fromEntries(calibrations.map((item) => [item.testId, item])),
      audits: audit.sections, options: settings, copilotVersion, sourceDatasetId: dataset.datasetId,
    });
    journal.completeOperation(activeOperationId, destination);
    progress?.({ type: 'complete', workflow: 'recalibration', title: 'Dataset recalibrated without extraction', summary: [`${dataset.questions.length} existing questions passed oracle calibration`, `Copilot CLI ${dataset.manifest.copilotCliVersion} → ${copilotVersion}`, `New dataset ${path.basename(destination)} · source ${dataset.datasetId}`], output: destination });
    return destination;
  } finally {
    journal.close();
    if (generatedRunner) await baseRunner.close();
    if (generatedJudge) await baseJudge.close();
    await rm(runWork, { recursive: true, force: true });
  }
}

// Scratch space is per process so concurrent runs sharing a work directory cannot delete each other's files.
function processWorkRoot(workRoot, kind) {
  return path.resolve(workRoot, `${kind}_${randomUUID().replaceAll('-', '').slice(0, 16)}`);
}

export async function buildDataset({ corpusPath, outputRoot = 'datasets', workRoot = '.work/dataset', options = {}, runner, judgeRunner, progress }) {
  const settings = {
    model: 'gpt-5.6-sol', judgeModel: undefined, reasoningEffort: 'medium', maxAiCredits: 100,
    timeoutSeconds: 600, timeoutRetries: 1, maxAttempts: 3, cleanResidualPasses: 1, concurrency: 10, resume: true,
    maxResidualPasses: 3, maxSectionChars: 12_000, ...options,
  };
  settings.judgeModel ??= settings.model;
  progress?.({ type: 'start', workflow: 'dataset', title: 'Building dataset', current: 'Reading Markdown corpus', progress: { done: 0, total: 0, label: 'knowledge items covered' } });
  const documents = await loadCorpus(corpusPath);
  const documentById = new Map(documents.map((document) => [document.documentId, document]));
  const sections = documents.flatMap((document) => splitDocument(document, settings.maxSectionChars));
  if (!sections.length) throw new DatasetBuildError('Corpus has no non-empty sections');
  const dashboard = { documents: documents.length, sections: sections.length, completed: 0, running: 0, resumed: 0, sectionItems: new Map(), sectionCovered: new Map(), sectionGenerated: new Map(), sectionCalibrated: new Map(), estimate: { concurrency: settings.concurrency, sections: new Map() } };
  progress?.({ type: 'update', workflow: 'dataset', title: 'Building dataset', current: `Preparing ${formatCount(sections.length, 'section')}`, progress: datasetProgress(dashboard) });
  const generatedRunner = !runner;
  const generatedJudge = !runner && !judgeRunner;
  const limiter = new AsyncLimiter(settings.concurrency);
  // Admitting only as many sections as call slots finishes sections steadily instead of interleaving every section's stages.
  const sectionLimiter = new AsyncLimiter(settings.concurrency);
  const runWork = processWorkRoot(workRoot, 'build');
  const baseRunner = runner ?? new CopilotSdkRunner({ model: settings.model, reasoningEffort: settings.reasoningEffort, timeoutSeconds: settings.timeoutSeconds, maxTimeoutRetries: settings.timeoutRetries, isolatedHome: path.join(runWork, 'home', 'subject'), progress });
  const activeRunner = limitRunner(baseRunner, limiter);
  const workspace = path.join(runWork, 'generation');
  await mkdir(workspace, { recursive: true });
  const allItems = [];
  const allEvidence = [];
  const allQuestions = [];
  const verifications = {};
  const calibrations = {};
  const audits = [];
  const baseJudge = judgeRunner ?? runner ?? new CopilotSdkRunner({ model: settings.judgeModel, reasoningEffort: settings.reasoningEffort, timeoutSeconds: settings.timeoutSeconds, maxTimeoutRetries: settings.timeoutRetries, isolatedHome: path.join(runWork, 'home', 'judge'), progress });
  const activeJudge = baseJudge === baseRunner ? activeRunner : limitRunner(baseJudge, limiter);
  const copilotVersion = await activeRunner.version();
  const operationInputs = { corpusRevision: corpusRevision(documents), pipelineVersion: DATASET_PIPELINE_VERSION, judgeConsensusPolicyVersion: JUDGE_CONSENSUS_POLICY_VERSION, copilotVersion, model: settings.model, judgeModel: settings.judgeModel, reasoningEffort: settings.reasoningEffort, maxAttempts: settings.maxAttempts, cleanResidualPasses: settings.cleanResidualPasses, maxResidualPasses: settings.maxResidualPasses, maxSectionChars: settings.maxSectionChars };
  const baseOperationId = operationId('dataset', operationInputs);
  const journalPath = path.resolve(workRoot, 'operations.sqlite');
  const journal = await OperationJournal.open(journalPath);
  const activeOperationId = settings.resume ? journal.findResumableOperation('dataset', operationInputs)?.operationId ?? baseOperationId : `${baseOperationId}_${randomUUID().slice(0, 8)}`;
  journal.startOperation({ operationId: activeOperationId, kind: 'dataset', inputs: operationInputs, config: { concurrency: settings.concurrency, timeoutRetries: settings.timeoutRetries, fresh: !settings.resume } });
  progress?.({ type: 'operation', workflow: 'dataset', message: `Dataset operation ${activeOperationId}; concurrency ${settings.concurrency}; journal ${journalPath}`, details: { operationId: activeOperationId, concurrency: settings.concurrency, journalPath } });
  try {
    const sectionTasks = sections.map(async (section, sectionIndex) => {
      const document = documentById.get(section.documentId);
      const job = journal.ensureJob({ operationId: activeOperationId, stage: 'section', entityId: section.sectionId, inputs: { section, documentRevision: document.revision, pipelineVersion: DATASET_PIPELINE_VERSION } });
      if (job.status === 'completed') {
        dashboard.completed += 1; dashboard.resumed += 1;
        updateSectionResults(dashboard, section.sectionId, { items: job.output.items.length, covered: job.output.items.length, generated: job.output.questions.length, calibrated: job.output.questions.length });
        progress?.({ type: 'update', workflow: 'dataset', current: `Reusing section ${sectionIndex + 1} of ${sections.length}`, progress: datasetProgress(dashboard) });
        return job.output;
      }
      dashboard.estimate.sections.set(section.sectionId, { chars: section.content.length, calls: 0, items: undefined, questions: 0, completed: false });
      return sectionLimiter.run(async () => {
        const workerId = randomUUID();
        if (!journal.claimJob(job.jobId, workerId)) throw new DatasetBuildError(`Could not claim section job ${section.sectionId}`);
        const lease = setInterval(() => journal.renewLease(job.jobId, workerId), 5 * 60 * 1000);
        lease.unref();
        dashboard.running += 1;
        progress?.({ type: 'update', workflow: 'dataset', current: `Inventorying section ${sectionIndex + 1} of ${sections.length}`, progress: datasetProgress(dashboard) });
        try {
          const onCall = () => {
            dashboard.estimate.sections.get(section.sectionId).calls += 1;
            progress?.({ type: 'update', workflow: 'dataset', progress: datasetProgress(dashboard) });
          };
          const output = await processSection({ section, sectionIndex, sectionCount: sections.length, document, runner: countCalls(activeRunner, onCall), judgeRunner: countCalls(activeJudge, onCall), workspace: path.join(workspace, section.sectionId), settings, progress, onResults: (results) => {
            updateSectionResults(dashboard, section.sectionId, results);
            progress?.({ type: 'update', workflow: 'dataset', progress: datasetProgress(dashboard) });
          } });
          journal.completeJob(job.jobId, workerId, output);
          Object.assign(dashboard.estimate.sections.get(section.sectionId), { items: output.items.length, completed: true });
          dashboard.running -= 1; dashboard.completed += 1;
          progress?.({ type: 'update', workflow: 'dataset', current: `Finalized section ${sectionIndex + 1} of ${sections.length}`, progress: datasetProgress(dashboard) });
          return output;
        } catch (error) {
          dashboard.running -= 1;
          journal.failJob(job.jobId, workerId, error);
          throw error;
        } finally {
          clearInterval(lease);
        }
      });
    });
    const settled = await Promise.allSettled(sectionTasks);
    const failure = settled.find((result) => result.status === 'rejected');
    if (failure) { progress?.({ type: 'error', workflow: 'dataset', message: failure.reason.message, progress: datasetProgress(dashboard) }); throw failure.reason; }
    for (const result of settled) {
      const output = result.value;
      allItems.push(...output.items);
      allEvidence.push(...output.evidence);
      allQuestions.push(...output.questions);
      audits.push(output.audit);
      Object.assign(verifications, output.verifications);
      Object.assign(calibrations, output.calibrations);
    }
    assertCompleteCoverage(allItems, allQuestions);
    journal.assertAllJobsCompleted(activeOperationId);
    const finalCounts = journal.jobCounts(activeOperationId);
    progress?.({ type: 'checkpoint', workflow: 'dataset', current: 'Publishing immutable dataset', progress: datasetProgress(dashboard), details: { jobs: finalCounts } });
    const destination = await publishDataset({ outputRoot, documents, sections, items: allItems, evidence: deduplicateEvidence(allEvidence), questions: allQuestions, verifications, calibrations, audits, options: settings, copilotVersion });
    journal.completeOperation(activeOperationId, destination);
    progress?.({ type: 'complete', workflow: 'dataset', title: 'Dataset built', summary: [`${formatCount(documents.length, 'document')}, ${formatCount(sections.length, 'section')}`, `${formatCount(allItems.length, 'knowledge item')}, ${formatCount(allQuestions.length, 'question')}`, 'Coverage 100%, calibration passed'], details: { destination, operationId: activeOperationId } });
    return destination;
  } finally {
    journal.close();
    if (generatedRunner) await baseRunner.close();
    if (generatedJudge) await baseJudge.close();
    await rm(runWork, { recursive: true, force: true });
  }
}

async function processSection({ section, sectionIndex, sectionCount, document, runner, judgeRunner, workspace, settings, progress, onResults }) {
    await mkdir(workspace, { recursive: true });
    sectionProgress(progress, 'Inventorying knowledge', sectionIndex, sectionCount);
      const initial = await extractInventory(runner, workspace, section, document, settings, []);
      let items = [...initial.items];
      let evidence = [...initial.evidence];
      onResults?.({ items: items.length, covered: 0 });
      let cleanPasses = 0;
      let residualPass = 0;
      let residualRecovered = false;
      let lastResidual;
      while (cleanPasses < settings.cleanResidualPasses) {
        residualPass += 1;
        if (residualPass > settings.maxResidualPasses) throw new DatasetBuildError(`Inventory did not converge for section ${section.sectionId}`);
        sectionProgress(progress, 'Checking knowledge coverage', sectionIndex, sectionCount);
        const residual = await extractInventory(runner, workspace, section, document, settings, items);
        lastResidual = residual;
        const known = new Set(items.map((item) => item.knowledgeId));
        const additions = residual.items.filter((item) => !known.has(item.knowledgeId));
        if (additions.length) {
          residualRecovered = true;
          const evidenceIds = new Set(additions.flatMap((item) => item.evidenceIds));
          items.push(...additions);
          evidence.push(...residual.evidence.filter((record) => evidenceIds.has(record.evidenceId)));
          onResults?.({ items: items.length, covered: 0 });
          cleanPasses = 0;
        } else cleanPasses += 1;
      }
      sectionProgress(progress, 'Preparing questions', sectionIndex, sectionCount);
      onResults?.({ items: items.length, covered: 0, generated: 0, calibrated: 0 });
      let merged = { sectionId: section.sectionId, classification: items.length ? 'informational' : 'non_informational', reason: initial.reason, items, evidence: deduplicateEvidence(evidence) };
      const recoveredKnowledgeIds = [];
      let audit = lastResidual;
      let converged = !residualRecovered;
      for (let auditPass = 1; residualRecovered && auditPass <= settings.maxResidualPasses; auditPass += 1) {
        sectionProgress(progress, 'Auditing completeness', sectionIndex, sectionCount);
        audit = await extractInventory(runner, workspace, section, document, settings, merged.items);
        const known = new Set(merged.items.map((item) => item.knowledgeId));
        const missing = audit.items.filter((item) => !known.has(item.knowledgeId));
        if (!missing.length) { converged = true; break; }
        recoveredKnowledgeIds.push(...missing.map((item) => item.knowledgeId));
        const evidenceIds = new Set(missing.flatMap((item) => item.evidenceIds));
        merged = { ...merged, classification: 'informational', items: [...merged.items, ...missing], evidence: deduplicateEvidence([...merged.evidence, ...audit.evidence.filter((record) => evidenceIds.has(record.evidenceId))]) };
        onResults?.({ items: merged.items.length, covered: 0 });
        sectionProgress(progress, 'Updating knowledge inventory', sectionIndex, sectionCount);
      }
      if (!converged) throw new DatasetBuildError(`Completeness audit did not converge for section ${section.sectionId}`);
      const sectionAudit = { sectionId: section.sectionId, passed: true, missingKnowledgeIds: [], recoveredKnowledgeIds, reason: audit.reason };
      let generated = { questions: [], verifications: {}, calibrations: {} };
      if (merged.items.length) {
        generated = await generateVerifiedQuestions({ runner, judgeRunner, workspace, inventory: merged, options: settings, progress, sectionIndex: sectionIndex + 1, sectionCount, source: document.content, onResults });
      }
      return { items: merged.items, evidence: merged.evidence, audit: sectionAudit, ...generated };
}

async function extractInventory(runner, workspace, section, document, options, existingItems) {
  return runStructured({ runner, workspace, prompt: buildInventoryPrompt(section, existingItems), validator: (response) => parseInventoryResponse(response, { section, document }), maxAttempts: options.maxAttempts });
}

async function generateVerifiedQuestions({ runner, judgeRunner, workspace, inventory, options, progress, sectionIndex, sectionCount, source, onResults }) {
  const retained = [];
  const verifications = {};
  const calibrations = {};
  let pendingItems = inventory.items;
  let feedback = '';
  let lastFailure = '';
  let generatedCount = 0;
  let calibratedCount = 0;
  let generationAttempt = 0;
  while (pendingItems.length) {
    generationAttempt += 1;
    const pendingEvidenceIds = new Set(pendingItems.flatMap((item) => item.evidenceIds));
    const basePrompt = buildQuestionPrompt(pendingItems, inventory.evidence.filter((record) => pendingEvidenceIds.has(record.evidenceId)));
    const prompt = feedback ? [basePrompt, '', 'The previous question set failed independent verification:', feedback, 'Generate replacement questions for all supplied knowledge IDs.', 'Correct every reported issue without changing the source facts.'].join('\n') : basePrompt;
    sectionProgress(progress, 'Generating questions', sectionIndex - 1, sectionCount);
    const questions = await runStructured({ runner, workspace, prompt, validator: (response) => parseQuestionResponse(response, pendingItems), maxAttempts: options.maxAttempts });
    generatedCount += questions.length;
    onResults?.({ items: inventory.items.length, generated: generatedCount, calibrated: calibratedCount });
    sectionProgress(progress, 'Calibrating questions', sectionIndex - 1, sectionCount);
    const outcomes = await Promise.all(questions.map(async (question, questionIndex) => {
      const questionWorkspace = path.join(workspace, 'questions', question.testId);
      await mkdir(questionWorkspace, { recursive: true });
      progress?.({ type: 'update', workflow: 'dataset', current: `Calibrating question ${questionIndex + 1} of ${questions.length} · section ${sectionIndex} of ${sectionCount}` });
      const calibration = await calibrateQuestion({ runner, judgeRunner, workspace: questionWorkspace, question, source, maxAttempts: options.maxAttempts, generationAttempt });
      calibratedCount += 1;
      onResults?.({ items: inventory.items.length, generated: generatedCount, calibrated: calibratedCount });
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
    onResults?.({ items: inventory.items.length, covered: coveredIds.size, generated: generatedCount, calibrated: calibratedCount });
    pendingItems = inventory.items.filter((item) => !coveredIds.has(item.knowledgeId));
    if (!pendingItems.length) return { questions: retained, verifications, calibrations };
    lastFailure = failures.join('\n');
    sectionProgress(progress, `Regenerating ${formatCount(pendingItems.length, 'unresolved item')} (attempt ${generationAttempt + 1})`, sectionIndex - 1, sectionCount);
    feedback = lastFailure;
  }
}

async function calibrateQuestion({ runner, judgeRunner, workspace, question, source, maxAttempts, generationAttempt }) {
  const oracle = await runner.run(workspace, oraclePrompt(question.question, [source]));
  const judged = await judgeWithConsensus({ judgeRunner, workspace: path.join(workspace, 'judgments'), question, sources: [source], answer: oracle.answer, maxAttempts });
  return { testId: question.testId, answer: oracle.answer, ...judged, generationAttempt, oracleAttempts: 1 };
}

async function recalibrateQuestion({ runner, judgeRunner, workspace, question, sources, maxAttempts, generationAttempt, oracleAttempt }) {
  await Promise.all([mkdir(path.join(workspace, 'oracle'), { recursive: true }), mkdir(path.join(workspace, 'judge'), { recursive: true })]);
  const oracle = await runner.run(path.join(workspace, 'oracle'), oraclePrompt(question.question, sources, question.rubric));
  const judged = await judgeWithConsensus({ judgeRunner, workspace: path.join(workspace, 'judge'), question, sources, answer: oracle.answer, maxAttempts });
  return { testId: question.testId, answer: oracle.answer, ...judged, generationAttempt, oracleAttempts: oracleAttempt };
}

async function judgeWithConsensus({ judgeRunner, workspace, question, sources, answer, maxAttempts }) {
  const prompt = buildCalibrationPrompt({ question: question.question, source: sources, candidateAnswer: answer, rubric: question.rubric });
  const judgments = [];
  const runJudgment = async () => {
    const judgmentWorkspace = path.join(workspace, `judgment-${judgments.length + 1}`);
    await mkdir(judgmentWorkspace, { recursive: true });
    const judgment = await runStructured({ runner: judgeRunner, workspace: judgmentWorkspace, prompt, validator: (response) => parseCalibrationResponse(response, question.rubric.length), maxAttempts });
    const score = judgment.criterionResults.reduce((sum, result) => sum + question.rubric[result.criterionIndex].weight * result.score, 0);
    const passed = judgmentPassed({ ...judgment, score });
    judgments.push({ ...judgment, score, passed });
  };
  for (let index = 0; index < INITIAL_JUDGMENTS; index += 1) await runJudgment();
  if (!judgments.every((judgment) => judgment.passed === judgments[0].passed)) {
    for (let index = 0; index < DISAGREEMENT_JUDGMENTS; index += 1) await runJudgment();
  }
  const passVotes = judgments.filter((judgment) => judgment.passed).length;
  const failVotes = judgments.length - passVotes;
  const verdict = judgments.length === INITIAL_JUDGMENTS
    ? (passVotes === INITIAL_JUDGMENTS ? 'pass' : 'fail')
    : (passVotes >= SUPERMAJORITY_VOTES ? 'pass' : failVotes >= SUPERMAJORITY_VOTES ? 'fail' : 'unstable');
  const representative = judgments.find((judgment) => judgment.passed === (verdict === 'pass')) ?? judgments[0];
  return {
    criterionResults: representative.criterionResults,
    unsupportedClaims: representative.unsupportedClaims,
    verification: representative.verification,
    integrity: representative.integrity,
    score: representative.score,
    judgments,
    judgeConsensus: { policyVersion: JUDGE_CONSENSUS_POLICY_VERSION, verdict, passVotes, failVotes, totalJudgments: judgments.length },
  };
}

async function settleAll(promises) {
  const settled = await Promise.allSettled(promises);
  const failure = settled.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  return settled.map((result) => result.value);
}

function assertCompleteCoverage(items, questions) {
  const covered = new Set(questions.flatMap((question) => question.rubric.flatMap((criterion) => criterion.knowledgeItemIds)));
  const missing = items.map((item) => item.knowledgeId).filter((id) => !covered.has(id)).sort();
  if (missing.length) throw new DatasetBuildError(`Dataset does not cover accepted knowledge items: ${missing.join(', ')}`);
}

function datasetProgress(state) {
  const items = [...state.sectionItems.values()].reduce((sum, count) => sum + count, 0);
  const covered = [...state.sectionCovered.values()].reduce((sum, count) => sum + count, 0);
  return { done: covered, total: items, eta: estimateDatasetCalls(state.estimate), label: 'knowledge items covered' };
}

const DEFAULT_CALLS_PER_ITEM = 1;
const CALLS_PER_QUESTION = 1 + INITIAL_JUDGMENTS;

// Estimates remaining work in Copilot calls, which complete steadily, rather than in covered items, which only move when a whole section finishes.
export function estimateDatasetCalls({ concurrency, sections }) {
  const records = [...sections.values()];
  const done = records.reduce((sum, record) => sum + record.calls, 0);
  const inventoried = records.filter((record) => record.items !== undefined);
  const inventoriedChars = inventoried.reduce((sum, record) => sum + record.chars, 0);
  if (!records.length || !inventoried.length || !inventoriedChars || done < Math.min(concurrency, records.length)) return { done, total: undefined };
  const itemsPerChar = inventoried.reduce((sum, record) => sum + record.items, 0) / inventoriedChars;
  const callsPerItem = learnedCallsPerItem(records);
  const remaining = records.reduce((sum, record) => {
    if (record.completed) return sum;
    const items = record.items ?? record.chars * itemsPerChar;
    const predicted = fixedSectionCalls(items) + (record.questions ? CALLS_PER_QUESTION * record.questions : callsPerItem * items);
    return sum + Math.max(predicted - record.calls, record.calls ? 1 : predicted);
  }, 0);
  return { done, total: done + Math.round(remaining) };
}

function learnedCallsPerItem(records) {
  const completed = records.filter((record) => record.completed && record.items > 0);
  const completedItems = completed.reduce((sum, record) => sum + record.items, 0);
  if (completedItems) return Math.max(0, completed.reduce((sum, record) => sum + record.calls - fixedSectionCalls(record.items), 0)) / completedItems;
  const generated = records.filter((record) => record.questions && record.items > 0);
  const generatedItems = generated.reduce((sum, record) => sum + record.items, 0);
  if (generatedItems) return CALLS_PER_QUESTION * generated.reduce((sum, record) => sum + record.questions, 0) / generatedItems;
  return DEFAULT_CALLS_PER_ITEM;
}

function fixedSectionCalls(items) {
  // Initial inventory plus one clean residual pass; informational sections also need a generation call.
  return items > 0 ? 3 : 2;
}

function countCalls(runner, onCall) {
  return {
    async run(...args) {
      try { return await runner.run(...args); }
      finally { onCall(); }
    },
  };
}

function sectionProgress(progress, phase, sectionIndex, sectionCount) {
  progress?.({ type: 'update', workflow: 'dataset', current: `${phase} · section ${sectionIndex + 1} of ${sectionCount}` });
}

function updateSectionResults(state, sectionId, { items, covered, generated, calibrated }) {
  if (items !== undefined) {
    state.sectionItems.set(sectionId, items);
    const estimate = state.estimate?.sections.get(sectionId);
    if (estimate) estimate.items = items;
  }
  if (generated) {
    const estimate = state.estimate?.sections.get(sectionId);
    if (estimate) estimate.questions = generated;
  }
  if (covered !== undefined) state.sectionCovered.set(sectionId, covered);
  if (generated !== undefined) state.sectionGenerated.set(sectionId, generated);
  if (calibrated !== undefined) state.sectionCalibrated.set(sectionId, calibrated);
}

function formatCount(count, singular) {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

async function publishDataset({ outputRoot, documents, sections, items, evidence, questions, verifications, calibrations, audits, options, copilotVersion, sourceDatasetId }) {
  const sourceDocuments = documents.map(({ documentId, revision, content }) => ({ documentId, revision, content }));
  const calibrationRecords = Object.values(calibrations).sort((a, b) => a.testId.localeCompare(b.testId, 'en'));
  const canonicalValue = { corpusRevision: corpusRevision(documents), documents: sourceDocuments, knowledge: items, questions, evidence, calibrations: calibrationRecords };
  const datasetId = `ds_${sha256(stableStringify(canonicalValue)).slice(0, 16)}`;
  const destination = path.resolve(outputRoot, datasetId);
  try { await access(destination); return destination; } catch {}
  await mkdir(path.resolve(outputRoot), { recursive: true });
  const staging = path.resolve(outputRoot, `.${datasetId}.building`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging);
  try {
    await writeJsonl(path.join(staging, 'documents.jsonl'), sourceDocuments);
    await writeJsonl(path.join(staging, 'knowledge.jsonl'), items);
    await writeJsonl(path.join(staging, 'evidence.jsonl'), evidence);
    await writeJsonl(path.join(staging, 'questions.jsonl'), questions);
    await writeJsonl(path.join(staging, 'calibrations.jsonl'), calibrationRecords);
    await writeJson(path.join(staging, 'coverage.json'), { acceptedItems: items.length, coveredItems: items.length, coverage: 1, sections: sections.length, informationalSections: new Set(items.map((item) => item.sectionId)).size });
    await writeJson(path.join(staging, 'audit.json'), { sections: audits });
    await writeJson(path.join(staging, 'verifications.json'), verifications);
    await writeJson(path.join(staging, 'manifest.json'), { schemaVersion: DATASET_SCHEMA_VERSION, datasetId, createdAt: new Date().toISOString(), ...(sourceDatasetId ? { sourceDatasetId } : {}), corpusRevision: canonicalValue.corpusRevision, extractorVersion: '0.4.0', copilotCliVersion: copilotVersion, model: options.model, reasoningEffort: options.reasoningEffort, timeoutSeconds: options.timeoutSeconds, timeoutRetries: options.timeoutRetries, calibration: { model: options.model, judgeModel: options.judgeModel, reasoningEffort: options.reasoningEffort, oraclePromptVersion: ORACLE_PROMPT_VERSION, judgeConsensus: { policyVersion: JUDGE_CONSENSUS_POLICY_VERSION, initialJudgments: INITIAL_JUDGMENTS, additionalJudgmentsOnDisagreement: DISAGREEMENT_JUDGMENTS, supermajorityVotes: SUPERMAJORITY_VOTES }, requiredScore: 1 }, documentRevisions: Object.fromEntries(documents.map((document) => [document.documentId, document.revision])) });
    await rename(staging, destination);
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
  return destination;
}

export async function loadDataset(datasetPath, { progress } = {}) {
  const root = path.resolve(datasetPath);
  const manifest = await readJson(path.join(root, 'manifest.json'));
  if (manifest.schemaVersion !== DATASET_SCHEMA_VERSION) throw new Error(`Dataset schema version ${DATASET_SCHEMA_VERSION} is required; rebuild the dataset with this JavaScript version`);
  if (typeof manifest.datasetId !== 'string' || manifest.datasetId !== path.basename(root)) throw new Error('Dataset ID does not match its directory name');
  progress?.({ done: 1, total: 7, current: 'Reading dataset records' });
  const [knowledge, questions, evidence, documents, calibrations] = await Promise.all(['knowledge.jsonl', 'questions.jsonl', 'evidence.jsonl', 'documents.jsonl', 'calibrations.jsonl'].map((name) => readJsonl(path.join(root, name))));
  progress?.({ done: 2, total: 7, current: 'Checking content hash' });
  const canonical = stableStringify({ corpusRevision: manifest.corpusRevision, documents, knowledge, questions, evidence, calibrations });
  const expectedId = `ds_${sha256(canonical).slice(0, 16)}`;
  if (expectedId !== manifest.datasetId) throw new Error(`Dataset content hash mismatch: expected ${expectedId}, found ${manifest.datasetId}`);
  progress?.({ done: 3, total: 7, current: 'Checking evidence references' });
  const evidenceIds = new Set(evidence.map((item) => item.evidenceId));
  const missingEvidence = [...new Set(questions.flatMap((question) => question.evidenceIds).filter((id) => !evidenceIds.has(id)))].sort();
  if (missingEvidence.length) throw new Error(`Questions reference missing evidence: ${missingEvidence.join(', ')}`);
  progress?.({ done: 4, total: 7, current: 'Checking source documents' });
  const documentMap = Object.fromEntries(documents.map((document) => [document.documentId, document.content]));
  const missingDocuments = [...new Set(evidence.map((item) => item.documentId).filter((id) => !(id in documentMap)))].sort();
  if (missingDocuments.length) throw new Error(`Evidence references missing source documents: ${missingDocuments.join(', ')}`);
  progress?.({ done: 5, total: 7, current: 'Checking inventory coverage' });
  if ((await readJson(path.join(root, 'coverage.json'))).coverage !== 1) throw new Error('Dataset does not have 100% inventory coverage');
  progress?.({ done: 6, total: 7, current: 'Checking oracle calibrations' });
  const calibrationByTestId = new Map(calibrations.map((item) => [item.testId, item]));
  const requiresConsensus = manifest.calibration?.judgeConsensus?.policyVersion !== undefined;
  const invalidCalibrations = questions.filter((question) => {
    const calibration = calibrationByTestId.get(question.testId);
    return calibration?.score !== 1 || calibration?.integrity?.passed !== true || (requiresConsensus && !hasValidPassingConsensus(calibration, question));
  }).map((question) => question.testId);
  if (invalidCalibrations.length || calibrationByTestId.size !== questions.length) throw new Error(`Dataset does not have a perfect oracle calibration for every question: ${invalidCalibrations.join(', ')}`);
  progress?.({ done: 7, total: 7, current: 'Integrity verified' });
  return { datasetId: manifest.datasetId, questions, evidence, documents: documentMap, calibrations, manifest };
}

function hasValidPassingConsensus(calibration, question) {
  const judgments = calibration?.judgments;
  const consensus = calibration?.judgeConsensus;
  if (!Array.isArray(judgments) || !consensus || consensus.policyVersion !== JUDGE_CONSENSUS_POLICY_VERSION || consensus.verdict !== 'pass') return false;
  const validJudgments = judgments.every((judgment) => {
    const score = judgment.criterionResults?.reduce((sum, result) => sum + question.rubric[result.criterionIndex].weight * result.score, 0);
    return score === judgment.score && judgment.passed === judgmentPassed(judgment);
  });
  const passVotes = judgments.filter(judgmentPassed).length;
  const validCount = judgments.length === INITIAL_JUDGMENTS || judgments.length === INITIAL_JUDGMENTS + DISAGREEMENT_JUDGMENTS;
  const sufficientVotes = judgments.length === INITIAL_JUDGMENTS ? passVotes === INITIAL_JUDGMENTS : passVotes >= SUPERMAJORITY_VOTES;
  const representative = { criterionResults: calibration.criterionResults, unsupportedClaims: calibration.unsupportedClaims, verification: calibration.verification, integrity: calibration.integrity, score: calibration.score, passed: true };
  const representativeMatches = judgments.some((judgment) => stableStringify(judgment) === stableStringify(representative));
  return validJudgments && validCount && sufficientVotes && representativeMatches && consensus.passVotes === passVotes && consensus.failVotes === judgments.length - passVotes && consensus.totalJudgments === judgments.length;
}

function judgmentPassed(judgment) {
  return judgment.score === 1 && judgment.verification?.passed === true && judgment.integrity?.passed === true;
}

function deduplicateEvidence(records) {
  return [...new Map(records.map((record) => [record.evidenceId, record])).values()].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId, 'en'));
}

function sha256(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function formatJobCounts(counts) { return `completed ${counts.completed}, running ${counts.running}, pending ${counts.pending}, failed ${counts.failed}`; }