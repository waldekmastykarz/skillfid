import { randomUUID } from 'node:crypto';
import { access, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { assertBaselineCoverage, findCompatibleBaseline, writeBaseline } from './baseline.js';
import { AsyncLimiter, mapConcurrent } from './concurrency.js';
import { CopilotSdkRunner } from './copilot-sdk.js';
import { loadDataset } from './dataset.js';
import { buildSkillAuditPrompt, parseSkillAudit } from './diagnosis.js';
import { SkillfidError, UsageError } from './errors.js';
import { copyDirectory, hashDirectory, readJson, readJsonl, writeJson, writeJsonl } from './files.js';
import { buildJudgePrompt, parseJudgeResponse } from './judge.js';
import { operationId, OperationJournal, valueHash } from './journal.js';
import { buildProbeJudgePrompt, loadProbes, parseProbeJudgment, probeTrialPassed } from './probes.js';
import { skillPrompt, subjectPrompt } from './prompts.js';
import { selectQuestions } from './selection.js';
import { classifyFailure, summarizeStages } from './staging.js';
import { runStructured } from './structured.js';
import { buildSummary } from './summary.js';
import { inventorySkill, skillDisclosure, skillFileHashes, skillFilesRead } from './trace.js';

export class EvaluationError extends SkillfidError {
  constructor(message, options = {}) { super(message, { code: 'EVALUATION_ERROR', ...options }); }
}
const PERFECT_SCORE_TOLERANCE = 1e-9;
const SKILL_INVOCATION_MODES = new Set(['auto', 'explicit']);
export const EVALUATOR_VERSION = '0.9.0';

export async function evaluateDataset({ datasetPath, skillPath, baselineRoot = 'baselines', outputRoot = 'runs', workRoot = '.work/eval', options = {}, subjectRunner, judgeRunner, progress }) {
  const settings = { model: undefined, judgeModel: undefined, reasoningEffort: undefined, skillInvocation: 'auto', trialsPerQuestion: 3, maxAiCredits: 100, timeoutSeconds: 600, timeoutRetries: 1, maxAttempts: 2, diagnoseFailures: true, concurrency: 10, resume: true, adaptive: false, sample: undefined, seed: undefined, filter: undefined, since: undefined, probesPath: undefined, failUnder: undefined, ...options };
  validateEvaluationSettings(settings);
  progress?.({ type: 'start', workflow: 'evaluation', title: 'Evaluating skill', current: 'Reading calibrated questions', progress: { done: 0, total: 0, label: 'questions evaluated' } });
  const dataset = await loadDataset(datasetPath);
  settings.model ??= dataset.manifest.calibration.model;
  settings.judgeModel ??= dataset.manifest.calibration.judgeModel;
  settings.reasoningEffort ??= dataset.manifest.calibration.reasoningEffort;
  assertDatasetCalibrated(dataset.manifest);
  const knowledge = dataset.knowledge ?? await readJsonl(path.join(path.resolve(datasetPath), 'knowledge.jsonl'));
  const selection = selectQuestions({ questions: dataset.questions, knowledge, evidence: dataset.evidence, documents: dataset.documents, filter: settings.filter, sample: settings.sample, seed: settings.seed });
  const questions = selection.questions;
  const probes = settings.probesPath ? await loadProbes(settings.probesPath) : [];
  const skillSource = path.resolve(skillPath);
  try { await access(path.join(skillSource, 'SKILL.md')); } catch { throw new EvaluationError(`Skill directory has no SKILL.md: ${skillPath}`); }
  const skillFiles = await inventorySkill(skillSource);
  const incremental = settings.since ? await planIncremental({ sincePath: settings.since, dataset, settings, skillFiles, questions }) : undefined;
  const carriedIds = new Set(incremental?.carried.keys() ?? []);
  const dashboard = { workflow: 'evaluation', questions: questions.length + probes.length * settings.trialsPerQuestion, unit: probes.length ? 'questions and probe trials' : 'questions', completed: 0, completedQuestions: carriedIds.size, freshQuestions: 0, resumed: 0, diagnoses: 0, answering: 0, judging: 0, diagnosing: 0, skillTrials: 0, skillLoadedTrials: 0, latest: undefined, trackCalls: false, limiter: undefined };
  progress?.({ type: 'update', workflow: 'evaluation', current: 'Preparing isolated workspaces', progress: evaluationProgress(dashboard) });

  const runId = `run_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const runWork = path.resolve(workRoot, runId);
  const home = path.join(runWork, 'home');
  const closedWorkspace = path.join(runWork, 'isolation-check', 'closed');
  const skillWorkspace = path.join(runWork, 'isolation-check', 'skill');
  await mkdir(closedWorkspace, { recursive: true });
  await mkdir(skillWorkspace, { recursive: true });
  await copyDirectory(skillSource, path.join(skillWorkspace, '.github', 'skills', path.basename(skillSource)));
  const generatedSubject = !subjectRunner;
  const generatedJudge = !judgeRunner;
  const limiter = new AsyncLimiter(settings.concurrency, () => { if (dashboard.trackCalls) emit({ progress, dashboard }); });
  dashboard.limiter = limiter;
  const baseSubject = subjectRunner ?? new CopilotSdkRunner({ model: settings.model, reasoningEffort: settings.reasoningEffort, timeoutSeconds: settings.timeoutSeconds, maxTimeoutRetries: settings.timeoutRetries, isolatedHome: path.join(home, 'subject'), progress });
  const baseJudge = judgeRunner ?? new CopilotSdkRunner({ model: settings.judgeModel, reasoningEffort: settings.reasoningEffort, timeoutSeconds: settings.timeoutSeconds, maxTimeoutRetries: settings.timeoutRetries, isolatedHome: path.join(home, 'judge'), progress });
  const evidenceById = new Map(dataset.evidence.map((item) => [item.evidenceId, item]));
  let journal;
  let activeOperationId;
  try {
    emit({ progress, dashboard }, { current: 'Checking skill isolation' });
    const closedSkills = await baseSubject.listSkills(closedWorkspace);
    const skillSkills = await baseSubject.listSkills(skillWorkspace);
    assertEvaluationIsolation(closedSkills, skillSkills);
    const projectSkillName = projectSkillCommandName(skillSkills);
    const copilotCliVersion = await baseSubject.version();
    const compatibility = baselineCompatibility(dataset.datasetId, settings, copilotCliVersion);
    const baseline = await findCompatibleBaseline({ outputRoot: baselineRoot, compatibility });
    if (!baseline) throw missingBaselineError(datasetPath, baselineRoot, settings);
    assertBaselineCoverage(baseline, questions, 1);
    const skillHash = await hashDirectory(skillSource);
    const testIds = questions.map((question) => question.testId);
    const operationInputs = {
      datasetId: dataset.datasetId, baselineId: baseline.manifest.baselineId, skillHash, evaluatorVersion: EVALUATOR_VERSION, copilotCliVersion, model: settings.model, judgeModel: settings.judgeModel, reasoningEffort: settings.reasoningEffort,
      skillInvocation: settings.skillInvocation, trialsPerQuestion: settings.trialsPerQuestion, diagnoseFailures: settings.diagnoseFailures, adaptive: settings.adaptive,
      selection: { filter: selection.filter ?? null, sample: selection.sample ?? null, questionSet: valueHash(testIds) },
      probes: probes.length ? valueHash(probes) : null,
      since: incremental ? { runId: incremental.runId, rerun: valueHash(incremental.rerun) } : null,
    };
    const baseOperationId = operationId('evaluation', operationInputs);
    const journalPath = path.resolve(workRoot, 'operations.sqlite');
    journal = await OperationJournal.open(journalPath);
    activeOperationId = settings.resume ? journal.findResumableOperation('evaluation', operationInputs)?.operationId ?? baseOperationId : `${baseOperationId}_${randomUUID().slice(0, 8)}`;
    journal.startOperation({ operationId: activeOperationId, kind: 'evaluation', inputs: operationInputs, config: { concurrency: settings.concurrency, timeoutRetries: settings.timeoutRetries, fresh: !settings.resume } });
    journal.acquireOperationLock(activeOperationId);
    progress?.({ type: 'operation', workflow: 'evaluation', message: `Evaluation operation ${activeOperationId}; concurrency ${settings.concurrency}; journal ${journalPath}`, details: { operationId: activeOperationId, concurrency: settings.concurrency, journalPath } });
    dashboard.trackCalls = true;
    emit({ progress, dashboard }, { current: 'Starting question evaluations' });

    const ctx = {
      workflow: 'evaluation', journal, operationId: activeOperationId, runWork, subjectRunner: baseSubject, judgeRunner: baseJudge, maxAttempts: settings.maxAttempts, progress, dashboard, limiter,
      skill: { source: skillSource, files: skillFiles, textFiles: Object.fromEntries(skillFiles.filter((file) => file.content !== undefined).map((file) => [file.path, file.content])) },
    };
    const baselineByQuestion = groupByTest(baseline.answers);
    const baselineJudgmentsByQuestion = groupByTest(baseline.judgments);
    const states = new Map(questions.map((question) => {
      const documentIds = [...new Set(question.evidenceIds.map((id) => evidenceById.get(id).documentId))].sort();
      const quotes = question.evidenceIds.map((id) => evidenceById.get(id).quote).filter(Boolean);
      return [question.testId, { question, calibration: dataset.calibrations.find((item) => item.testId === question.testId), source: documentIds.map((id) => dataset.documents[id]), quotes, skillAnswers: [], skillJudgments: [], diagnosis: undefined }];
    }));
    const toRun = questions.filter((question) => !carriedIds.has(question.testId));
    const parallelTrials = settings.adaptive ? 1 : settings.trialsPerQuestion;
    const window = Math.ceil(settings.concurrency / parallelTrials) + 1;
    const trialIndexes = (from) => Array.from({ length: settings.trialsPerQuestion - from }, (_, offset) => from + offset);
    const evaluateQuestion = async (question) => {
      const state = states.get(question.testId);
      const prompt = skillPrompt(question.question, settings.skillInvocation, projectSkillName);
      const runTrial = (trial) => limiter.run(() => runConditionPipeline(ctx, { question, trial, condition: 'skill', prompt, source: state.source, quotes: state.quotes }));
      const results = [];
      if (settings.adaptive && settings.trialsPerQuestion > 1) {
        const first = await runTrial(0);
        results.push(first);
        if (first.answer.score < 1 - PERFECT_SCORE_TOLERANCE) results.push(...await settleAll(trialIndexes(1).map(runTrial)));
      } else results.push(...await settleAll(trialIndexes(0).map(runTrial)));
      results.sort((left, right) => left.answer.trial - right.answer.trial);
      state.skillAnswers = results.map((result) => result.answer);
      state.skillJudgments = results.map((result) => result.judgment);
      const baselineScores = (baselineByQuestion.get(question.testId) ?? []).map((answer) => answer.score);
      const averages = { closedBook: average(baselineScores), skill: average(state.skillAnswers.map((answer) => answer.score)), calibrationScore: state.calibration.score };
      if (averages.skill < 1 - PERFECT_SCORE_TOLERANCE && settings.diagnoseFailures) {
        dashboard.diagnoses += 1;
        state.diagnosis = await limiter.run(async () => {
          dashboard.diagnosing += 1;
          dashboard.latest = questionLabel(question);
          emit(ctx);
          try { return await runDiagnosisJob(ctx, { question, source: state.source, averages, skillAnswers: state.skillAnswers, skillJudgments: state.skillJudgments, skillSource, diagnosisRoot: path.join(runWork, 'diagnoses', question.testId), skillInvocation: settings.skillInvocation }); }
          finally { dashboard.diagnosing -= 1; }
        });
      }
      dashboard.completedQuestions += 1;
      if (!results.every((result) => result.reused)) dashboard.freshQuestions += 1;
      emit(ctx);
    };
    const probeRecords = [];
    try {
      await mapConcurrent(toRun, window, evaluateQuestion);
      if (probes.length) {
        const probeUnits = probes.flatMap((probe) => Array.from({ length: settings.trialsPerQuestion }, (_, trial) => ({ probe, trial })));
        const results = await mapConcurrent(probeUnits, settings.concurrency + 1, ({ probe, trial }) => limiter.run(() => runProbePipeline(ctx, { probe, trial, prompt: skillPrompt(probe.question, settings.skillInvocation, projectSkillName) })));
        probeRecords.push(...results);
      }
    } catch (error) {
      progress?.({ type: 'error', workflow: 'evaluation', message: error.message, progress: evaluationProgress(dashboard) });
      throw error;
    }

    const answers = [];
    const judgments = [];
    const diagnoses = [];
    const trialsRun = {};
    for (const question of questions) {
      const state = states.get(question.testId);
      const carried = incremental?.carried.get(question.testId);
      const closedAnswers = sortByTrial(baselineByQuestion.get(question.testId) ?? []);
      const closedJudgments = sortByTrial(baselineJudgmentsByQuestion.get(question.testId) ?? []);
      const skillAnswers = carried ? carried.answers.map((record) => ({ ...record, carriedFrom: incremental.runId })) : state.skillAnswers;
      const skillJudgments = carried ? carried.judgments.map((record) => ({ ...record, carriedFrom: incremental.runId })) : state.skillJudgments;
      answers.push(...closedAnswers, ...skillAnswers);
      judgments.push(...closedJudgments, ...skillJudgments);
      const diagnosis = carried ? carried.diagnosis && { ...carried.diagnosis, carriedFrom: incremental.runId } : state.diagnosis;
      if (diagnosis) diagnoses.push(diagnosis);
      trialsRun[question.testId] = skillAnswers.length;
    }
    journal.assertAllJobsCompleted(activeOperationId);
    const finalCounts = journal.jobCounts(activeOperationId);
    progress?.({ type: 'checkpoint', workflow: 'evaluation', current: 'Writing evaluation results', progress: evaluationProgress(dashboard), metrics: dashboardMetrics(dashboard), details: { jobs: finalCounts } });
    const resolvedOutputRoot = path.resolve(outputRoot);
    await mkdir(resolvedOutputRoot, { recursive: true });
    const destination = path.join(resolvedOutputRoot, runId);
    await mkdir(destination, { recursive: false });
    await writeJsonl(path.join(destination, 'answers.jsonl'), answers);
    await writeJsonl(path.join(destination, 'judgments.jsonl'), judgments);
    await writeJsonl(path.join(destination, 'diagnoses.jsonl'), diagnoses);
    if (probes.length) await writeJsonl(path.join(destination, 'probes.jsonl'), probeRecords);
    const incrementalSummary = incremental ? { since: incremental.runId, rerun: incremental.rerun.length, carried: incremental.carried.size } : undefined;
    const summary = buildSummary({ datasetId: dataset.datasetId, questions, totalQuestions: dataset.questions.length, calibrations: dataset.calibrations, answers, diagnoses, probeRecords, failUnder: settings.failUnder, selection, incremental: incrementalSummary });
    await writeJson(path.join(destination, 'summary.json'), summary);
    const manifest = {
      runId, createdAt: new Date().toISOString(), datasetId: dataset.datasetId, baselineId: baseline.manifest.baselineId, skillHash, skillFiles: skillFileHashes(skillFiles), evaluatorVersion: EVALUATOR_VERSION, copilotCliVersion,
      model: settings.model, judgeModel: settings.judgeModel, reasoningEffort: settings.reasoningEffort, skillInvocation: settings.skillInvocation, trialsPerQuestion: settings.trialsPerQuestion, adaptive: settings.adaptive, trialsRun,
      timeoutSeconds: settings.timeoutSeconds, timeoutRetries: settings.timeoutRetries, diagnoseFailures: settings.diagnoseFailures,
    };
    if (summary.partial) Object.assign(manifest, { partial: true, subset: summary.subset, ...(selection.sample ? { sample: { ...selection.sample, testIds } } : {}), ...(selection.filter ? { filter: selection.filter } : {}) });
    if (incremental) manifest.incremental = { ...incrementalSummary, changedFiles: { changed: incremental.changed, added: incremental.added, removed: incremental.removed } };
    if (probes.length) manifest.probes = { file: path.basename(settings.probesPath), count: probes.length, trialsPerProbe: settings.trialsPerQuestion };
    if (settings.failUnder !== undefined) manifest.failUnder = settings.failUnder;
    await writeJson(path.join(destination, 'manifest.json'), manifest);
    journal.completeOperation(activeOperationId, destination);
    const stageNote = Object.entries(summary.failureStages).filter(([, count]) => count).map(([stage, count]) => `${humanize(stage)} ${count}`).join(', ');
    progress?.({ type: 'complete', workflow: 'evaluation', title: 'Evaluation complete', summary: [`Closed book ${formatScore(summary.conditionScores.closedBook)}, skill ${formatScore(summary.conditionScores.skill)}${summary.partial ? ` (partial: ${summary.subset.questions} of ${summary.subset.of} questions)` : ''}`, `Uplift ${formatSignedScore(summary.skillUplift).replace('%', ' percentage points')}`, ...(stageNote ? [`Failure stages: ${stageNote}`] : []), `${formatCount(finalCounts.completed, 'job')} completed, ${finalCounts.failed} failed`], metrics: dashboardMetrics(dashboard), details: { destination, operationId: activeOperationId } });
    return destination;
  } catch (error) {
    if (journal && activeOperationId) { try { journal.failOperation(activeOperationId, error); } catch { /* the journal may already be closed */ } }
    throw error;
  } finally {
    journal?.close();
    if (generatedSubject) await baseSubject.close();
    if (generatedJudge) await baseJudge.close();
    await rm(runWork, { recursive: true, force: true });
    if (generatedSubject) await rm(home, { recursive: true, force: true });
  }
}

export async function evaluateBaseline({ datasetPath, outputRoot = 'baselines', workRoot = '.work/baseline', options = {}, subjectRunner, judgeRunner, progress }) {
  const settings = { model: undefined, judgeModel: undefined, reasoningEffort: undefined, trialsPerQuestion: 1, timeoutSeconds: 600, timeoutRetries: 1, maxAttempts: 2, concurrency: 10, resume: true, ...options };
  if (!Number.isInteger(settings.trialsPerQuestion) || settings.trialsPerQuestion < 1) throw new UsageError('trialsPerQuestion must be at least 1');
  progress?.({ type: 'start', workflow: 'baseline', title: 'Evaluating closed-book baseline', current: 'Reading calibrated questions', progress: { done: 0, total: 0, label: 'questions evaluated' } });
  const dataset = await loadDataset(datasetPath);
  settings.model ??= dataset.manifest.calibration.model;
  settings.judgeModel ??= dataset.manifest.calibration.judgeModel;
  settings.reasoningEffort ??= dataset.manifest.calibration.reasoningEffort;
  assertDatasetCalibrated(dataset.manifest);
  const dashboard = { workflow: 'baseline', questions: dataset.questions.length, unit: 'questions', completed: 0, completedQuestions: 0, freshQuestions: 0, resumed: 0, diagnoses: 0, answering: 0, judging: 0, diagnosing: 0, skillTrials: 0, skillLoadedTrials: 0, latest: undefined, trackCalls: false, limiter: undefined };
  const workId = `baseline_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const runWork = path.resolve(workRoot, workId);
  const home = path.join(runWork, 'home');
  const closedWorkspace = path.join(runWork, 'isolation-check', 'closed');
  await mkdir(closedWorkspace, { recursive: true });
  const generatedSubject = !subjectRunner;
  const generatedJudge = !judgeRunner;
  const limiter = new AsyncLimiter(settings.concurrency, () => { if (dashboard.trackCalls) emit({ progress, dashboard }); });
  dashboard.limiter = limiter;
  const baseSubject = subjectRunner ?? new CopilotSdkRunner({ model: settings.model, reasoningEffort: settings.reasoningEffort, timeoutSeconds: settings.timeoutSeconds, maxTimeoutRetries: settings.timeoutRetries, isolatedHome: path.join(home, 'subject'), progress });
  const baseJudge = judgeRunner ?? new CopilotSdkRunner({ model: settings.judgeModel, reasoningEffort: settings.reasoningEffort, timeoutSeconds: settings.timeoutSeconds, maxTimeoutRetries: settings.timeoutRetries, isolatedHome: path.join(home, 'judge'), progress });
  let journal;
  let activeOperationId;
  try {
    assertClosedBookIsolation(await baseSubject.listSkills(closedWorkspace));
    const copilotCliVersion = await baseSubject.version();
    const compatibility = baselineCompatibility(dataset.datasetId, settings, copilotCliVersion);
    const operationInputs = { ...compatibility, trialsPerQuestion: settings.trialsPerQuestion };
    const baseOperationId = operationId('baseline', operationInputs);
    const journalPath = path.resolve(workRoot, 'operations.sqlite');
    journal = await OperationJournal.open(journalPath);
    activeOperationId = settings.resume ? journal.findResumableOperation('baseline', operationInputs)?.operationId ?? baseOperationId : `${baseOperationId}_${randomUUID().slice(0, 8)}`;
    journal.startOperation({ operationId: activeOperationId, kind: 'baseline', inputs: operationInputs, config: { concurrency: settings.concurrency, timeoutRetries: settings.timeoutRetries, fresh: !settings.resume } });
    journal.acquireOperationLock(activeOperationId);
    progress?.({ type: 'operation', workflow: 'baseline', message: `Baseline operation ${activeOperationId}; concurrency ${settings.concurrency}; journal ${journalPath}`, details: { operationId: activeOperationId, concurrency: settings.concurrency, journalPath } });
    dashboard.trackCalls = true;
    const ctx = { workflow: 'baseline', journal, operationId: activeOperationId, runWork, subjectRunner: baseSubject, judgeRunner: baseJudge, maxAttempts: settings.maxAttempts, progress, dashboard, limiter };
    const evidenceById = new Map(dataset.evidence.map((item) => [item.evidenceId, item]));
    const units = dataset.questions.flatMap((question) => Array.from({ length: settings.trialsPerQuestion }, (_, trial) => ({ question, trial })));
    const completedByQuestion = new Map(dataset.questions.map((question) => [question.testId, 0]));
    const results = await mapConcurrent(units, settings.concurrency + settings.trialsPerQuestion, async ({ question, trial }) => {
      const documentIds = [...new Set(question.evidenceIds.map((id) => evidenceById.get(id).documentId))].sort();
      const output = await limiter.run(() => runConditionPipeline(ctx, { question, trial, condition: 'closedBook', prompt: subjectPrompt(question.question), source: documentIds.map((id) => dataset.documents[id]) }));
      const completed = completedByQuestion.get(question.testId) + 1;
      completedByQuestion.set(question.testId, completed);
      if (completed === settings.trialsPerQuestion) { dashboard.completedQuestions += 1; dashboard.freshQuestions += 1; }
      return output;
    });
    const answers = results.map((result) => result.answer);
    const judgments = results.map((result) => result.judgment);
    assertBaselineCoverage({ answers, judgments }, dataset.questions, settings.trialsPerQuestion);
    journal.assertAllJobsCompleted(activeOperationId);
    const finalCounts = journal.jobCounts(activeOperationId);
    const destination = await writeBaseline({ outputRoot, compatibility, answers, judgments });
    journal.completeOperation(activeOperationId, destination);
    const score = answers.reduce((sum, answer) => sum + answer.score, 0) / answers.length;
    progress?.({ type: 'complete', workflow: 'baseline', title: 'Baseline complete', summary: [`Closed book ${formatScore(score)}`, `${formatCount(finalCounts.completed, 'job')} completed, ${finalCounts.failed} failed`], metrics: dashboardMetrics(dashboard), details: { destination, operationId: activeOperationId } });
    return destination;
  } catch (error) {
    if (journal && activeOperationId) { try { journal.failOperation(activeOperationId, error); } catch { /* the journal may already be closed */ } }
    throw error;
  } finally {
    journal?.close();
    if (generatedSubject) await baseSubject.close();
    if (generatedJudge) await baseJudge.close();
    await rm(runWork, { recursive: true, force: true });
    if (generatedSubject) await rm(home, { recursive: true, force: true });
  }
}

function validateEvaluationSettings(settings) {
  if (!Number.isInteger(settings.trialsPerQuestion) || settings.trialsPerQuestion < 1) throw new UsageError('trialsPerQuestion must be at least 1');
  if (!SKILL_INVOCATION_MODES.has(settings.skillInvocation)) throw new UsageError(`skillInvocation must be one of: ${[...SKILL_INVOCATION_MODES].join(', ')}`);
  if (settings.sample !== undefined && (!Number.isInteger(settings.sample) || settings.sample < 1)) throw new UsageError('sample must be a positive integer');
  if (settings.seed !== undefined && !Number.isInteger(settings.seed)) throw new UsageError('seed must be an integer');
  if (settings.failUnder !== undefined && !(settings.failUnder >= 0 && settings.failUnder <= 1)) throw new UsageError('failUnder must be a number from 0 to 1');
}

// Decides which questions an incremental run can carry forward from a previous run and which must be evaluated again.
async function planIncremental({ sincePath, dataset, settings, skillFiles, questions }) {
  const root = path.resolve(sincePath);
  let previous;
  try {
    const [manifest, answers, judgments, diagnoses] = await Promise.all([readJson(path.join(root, 'manifest.json')), readJsonl(path.join(root, 'answers.jsonl')), readJsonl(path.join(root, 'judgments.jsonl')), readJsonl(path.join(root, 'diagnoses.jsonl'))]);
    previous = { manifest, answers, judgments, diagnoses };
  } catch (error) {
    throw new EvaluationError(`Cannot read the previous run for --since: ${error.message}`, { code: 'SINCE_INVALID', remedy: 'Pass a completed run directory (containing manifest.json, answers.jsonl, judgments.jsonl and diagnoses.jsonl).' });
  }
  const { manifest } = previous;
  if (manifest.datasetId !== dataset.datasetId) throw new EvaluationError(`The previous run used dataset ${manifest.datasetId}, not ${dataset.datasetId}.`, { code: 'SINCE_INCOMPATIBLE', remedy: 'Use a previous run of the same dataset, or omit --since.' });
  for (const key of ['model', 'judgeModel', 'reasoningEffort', 'skillInvocation']) {
    if (manifest[key] !== undefined && manifest[key] !== settings[key]) throw new EvaluationError(`The previous run used ${key} ${manifest[key]}, not ${settings[key]}; its results cannot be carried forward.`, { code: 'SINCE_INCOMPATIBLE', remedy: 'Rerun fully, or pass the same model settings as the previous run.' });
  }
  if (!manifest.skillFiles) throw new EvaluationError('The previous run did not record skillFiles, so changed files cannot be determined.', { code: 'SINCE_INCOMPATIBLE', remedy: 'Run a full evaluation with this version of skillfid first, then use it with --since.' });
  const current = skillFileHashes(skillFiles);
  const changed = Object.keys(current).filter((file) => file in manifest.skillFiles && manifest.skillFiles[file] !== current[file]).sort();
  const added = Object.keys(current).filter((file) => !(file in manifest.skillFiles)).sort();
  const removed = Object.keys(manifest.skillFiles).filter((file) => !(file in current)).sort();
  const touched = new Set([...changed, ...removed]);
  const skillAnswers = groupByTest(previous.answers.filter((answer) => answer.condition === 'skill'));
  const skillJudgments = groupByTest(previous.judgments.filter((judgment) => judgment.condition === 'skill'));
  const diagnosisByTest = new Map(previous.diagnoses.map((diagnosis) => [diagnosis.testId, diagnosis]));
  const carried = new Map();
  const rerun = [];
  for (const question of questions) {
    const answers = sortByTrial(skillAnswers.get(question.testId) ?? []);
    if (needsRerun(answers, touched)) { rerun.push(question.testId); continue; }
    carried.set(question.testId, { answers, judgments: sortByTrial(skillJudgments.get(question.testId) ?? []), diagnosis: diagnosisByTest.get(question.testId) });
  }
  return { runId: manifest.runId, changed, added, removed, carried, rerun };
}

// A question is re-evaluated when it has no results, scored below perfect, never loaded the skill, or read a file that changed.
function needsRerun(answers, touched) {
  if (!answers.length) return true;
  if (average(answers.map((answer) => answer.score)) < 1 - PERFECT_SCORE_TOLERANCE) return true;
  return answers.some((answer) => answer.trace?.skillLoaded !== true || skillFilesRead(answer.trace).some((file) => touched.has(file.path)));
}

function groupByTest(records) {
  const grouped = new Map();
  for (const record of records) grouped.set(record.testId, [...(grouped.get(record.testId) ?? []), record]);
  return grouped;
}

function sortByTrial(records) {
  return [...records].sort((left, right) => (left.trial ?? 0) - (right.trial ?? 0));
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

// Runs one journaled step: reuses a completed result, waits for a live owner, and records failures with details.
async function runStep(ctx, { stage, entityId, label, inputs, run }) {
  const job = ctx.journal.ensureJob({ operationId: ctx.operationId, stage, entityId, inputs, label });
  return ctx.journal.executeJob(job, async (info) => {
    try { return await run(info); }
    catch (error) { if (error instanceof Error && error.details === undefined) error.details = { stage, entityId, label }; throw error; }
  }, { onWait: ({ ownerPid }) => emit(ctx, { current: `Waiting for process ${ownerPid} to finish ${label}` }) });
}

async function runConditionPipeline(ctx, { question, trial, condition, prompt, source, quotes = [] }) {
  const { dashboard } = ctx;
  const entityId = `${question.testId}:${trial}:${condition}`;
  const label = `${questionLabel(question)} · trial ${trial + 1} ${conditionLabel(condition)}`;
  dashboard.answering += 1;
  dashboard.latest = label;
  emit(ctx);
  let stage = 'answering';
  try {
    const workspace = path.join(ctx.runWork, 'trials', question.testId, String(trial), condition, condition);
    const answerResult = await runStep(ctx, { stage: 'answer', entityId, label: `${label} answer`, inputs: { question, trial, condition, prompt }, run: async () => {
      await rm(workspace, { recursive: true, force: true });
      await mkdir(workspace, { recursive: true });
      if (condition === 'skill') await copyDirectory(ctx.skill.source, path.join(workspace, '.github', 'skills', path.basename(ctx.skill.source)));
      const result = await ctx.subjectRunner.run(workspace, prompt);
      return { testId: question.testId, trial, condition, answer: result.answer, durationSeconds: result.durationSeconds, ...(result.trace ? { trace: result.trace } : {}) };
    } });
    dashboard.answering -= 1; dashboard.judging += 1;
    stage = 'judging';
    emit(ctx);
    const judgeWorkspace = path.join(ctx.runWork, 'trials', question.testId, String(trial), condition, 'judge');
    const judgmentResult = await runStep(ctx, { stage: 'judgment', entityId, label: `${label} judgment`, inputs: { question, trial, condition, source, answer: answerResult.output }, run: async () => {
      await mkdir(judgeWorkspace, { recursive: true });
      const { score, judgment } = await judgeAnswer({ runner: ctx.judgeRunner, workspace: judgeWorkspace, question, source, answer: answerResult.output.answer, maxAttempts: ctx.maxAttempts });
      return { testId: question.testId, trial, condition, criterionResults: judgment.criterionResults, unsupportedClaims: judgment.unsupportedClaims, score };
    } });
    const judgment = judgmentResult.output;
    const answer = { ...answerResult.output, score: judgment.score };
    if (condition === 'skill') {
      const classified = classifyFailure({ score: judgment.score, trace: answer.trace, skillFiles: ctx.skill.files, evidenceQuotes: quotes, answer: answer.answer, unsupportedClaims: judgment.unsupportedClaims });
      if (classified) { answer.stage = classified.stage; answer.stageDetail = classified.detail; }
      const disclosure = skillDisclosure(answer.trace, ctx.skill.files);
      if (disclosure) answer.disclosure = disclosure;
      dashboard.skillTrials += 1;
      if (answer.trace?.skillLoaded) dashboard.skillLoadedTrials += 1;
    }
    dashboard.judging -= 1; dashboard.completed += 1;
    stage = 'completed';
    const reused = answerResult.reused && judgmentResult.reused;
    if (reused) dashboard.resumed += 1;
    return { answer, judgment, reused };
  } catch (error) {
    if (stage === 'judging') dashboard.judging -= 1;
    else if (stage === 'answering') dashboard.answering -= 1;
    throw error;
  }
}

// Probes run through the skill condition and are judged for refusal, hallucination and expected behaviors; they never feed the accuracy score.
async function runProbePipeline(ctx, { probe, trial, prompt }) {
  const { dashboard } = ctx;
  const entityId = `${probe.id}:${trial}`;
  const label = `Probe “${truncate(probe.id, 40)}” · trial ${trial + 1}`;
  dashboard.answering += 1;
  dashboard.latest = label;
  emit(ctx);
  let stage = 'answering';
  try {
    const workspace = path.join(ctx.runWork, 'probes', probe.id, String(trial), 'skill');
    const answerResult = await runStep(ctx, { stage: 'probe', entityId, label: `${label} answer`, inputs: { probe, trial, prompt }, run: async () => {
      await rm(workspace, { recursive: true, force: true });
      await mkdir(workspace, { recursive: true });
      await copyDirectory(ctx.skill.source, path.join(workspace, '.github', 'skills', path.basename(ctx.skill.source)));
      const result = await ctx.subjectRunner.run(workspace, prompt);
      return { answer: result.answer, durationSeconds: result.durationSeconds, ...(result.trace ? { trace: result.trace } : {}) };
    } });
    dashboard.answering -= 1; dashboard.judging += 1;
    stage = 'judging';
    emit(ctx);
    const judgeWorkspace = path.join(ctx.runWork, 'probes', probe.id, String(trial), 'judge');
    const judged = await runStep(ctx, { stage: 'probe_judgment', entityId, label: `${label} judgment`, inputs: { probe, trial, answer: answerResult.output.answer }, run: async () => {
      await mkdir(judgeWorkspace, { recursive: true });
      return runStructured({ runner: ctx.judgeRunner, workspace: judgeWorkspace, prompt: buildProbeJudgePrompt({ probe, answer: answerResult.output.answer, skillFiles: ctx.skill.textFiles }), validator: (response) => parseProbeJudgment(response, probe.behaviors.length), maxAttempts: ctx.maxAttempts });
    } });
    dashboard.judging -= 1; dashboard.completed += 1; dashboard.completedQuestions += 1; dashboard.freshQuestions += 1;
    stage = 'completed';
    emit(ctx);
    const judgment = judged.output;
    return { probeId: probe.id, trial, question: probe.question, expect: probe.expect, expectedBehaviors: probe.behaviors, ...answerResult.output, refused: judgment.refused, hallucinated: judgment.hallucinated, behaviors: judgment.behaviors, rationale: judgment.rationale, passed: probeTrialPassed(probe, judgment) };
  } catch (error) {
    if (stage === 'judging') dashboard.judging -= 1;
    else if (stage === 'answering') dashboard.answering -= 1;
    throw error;
  }
}

async function runDiagnosisJob(ctx, { question, skillAnswers, skillJudgments, ...inputs }) {
  const stageContext = diagnosisStageContext(skillAnswers);
  const trialJudgments = { skill: skillJudgments };
  const label = `${questionLabel(question)} diagnosis`;
  const result = await runStep(ctx, { stage: 'diagnosis', entityId: question.testId, label, inputs: { question, averages: inputs.averages, trialAnswers: { skill: skillAnswers }, trialJudgments, skillInvocation: inputs.skillInvocation }, run: () => diagnoseFailure({ question, trialJudgments, stageContext, subjectRunner: ctx.subjectRunner, judgeRunner: ctx.judgeRunner, maxAttempts: ctx.maxAttempts, ...inputs }) });
  return result.output;
}

function diagnosisStageContext(skillAnswers) {
  const counts = summarizeStages(skillAnswers);
  const failing = Object.fromEntries(Object.entries(counts).filter(([, count]) => count));
  const filesRead = [...new Set(skillAnswers.flatMap((answer) => skillFilesRead(answer.trace).map((file) => file.path)))].sort();
  return { trials: skillAnswers.length, stages: failing, skillLoadedTrials: skillAnswers.filter((answer) => answer.trace?.skillLoaded).length, skillFilesRead: filesRead };
}

async function settleAll(promises) {
  const settled = await Promise.allSettled(promises);
  const failure = settled.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  return settled.map((result) => result.value);
}

function emit(ctx, extra = {}) {
  const { dashboard, progress } = ctx;
  progress?.({ type: 'update', workflow: dashboard.workflow, current: evaluationAction(dashboard), progress: evaluationProgress(dashboard), metrics: dashboardMetrics(dashboard), ...extra });
}

function evaluationProgress(state) {
  return { done: state.completedQuestions, total: state.questions, etaDone: state.freshQuestions, label: `${state.unit} evaluated` };
}

function dashboardMetrics(state) {
  return {
    answering: state.answering,
    judging: state.judging,
    diagnosing: state.diagnosing,
    failed: state.limiter?.stats.failed ?? 0,
    ...(state.skillTrials ? { skillLoadedRate: `${Math.round(state.skillLoadedTrials / state.skillTrials * 100)}%` } : {}),
  };
}

function evaluationAction(state) {
  const actions = [];
  if (state.limiter?.stats.queued) actions.push(`${formatCount(state.limiter.stats.queued, 'job')} queued`);
  if (state.answering) actions.push(`${formatCount(state.answering, 'answer')} in progress`);
  if (state.judging) actions.push(`${formatCount(state.judging, 'judgment')} in progress`);
  if (state.diagnosing) actions.push(`${formatCount(state.diagnosing, 'diagnosis', 'diagnoses')} in progress`);
  if (!actions.length && state.resumed) return `Reused ${formatCount(state.resumed, 'completed evaluation')}`;
  if (!actions.length) return 'Preparing evaluations';
  return state.latest ? `${actions.join(' · ')} · latest: ${state.latest}` : actions.join(' · ');
}

function questionLabel(question) {
  return `“${truncate(question.question.replace(/\s+/g, ' ').trim(), 48)}”`;
}

function truncate(text, length) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

export function formatScore(score) {
  return `${formatPercentage(score)}%`;
}

function formatSignedScore(score) {
  const value = formatPercentage(score);
  return `${score >= 0 ? '+' : ''}${value}%`;
}

function formatPercentage(score) {
  if (score === 0 || Math.abs(score) === 1) return String(score * 100);
  const percentage = score * 100;
  let precision = 3;
  let formatted = percentage.toFixed(precision);
  while (Number(formatted) === Math.sign(score) * 100 && precision < 10) {
    precision += 1;
    formatted = percentage.toFixed(precision);
  }
  return formatted.replace(/\.0+$|(\.\d*?)0+$/, '$1');
}

function formatCount(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function conditionLabel(condition) {
  return condition === 'closedBook' ? 'closed book' : 'skill';
}

function humanize(value) {
  return value.replaceAll('_', ' ');
}

async function judgeAnswer({ runner, workspace, question, source, answer, maxAttempts }) {
  const judgment = await runStructured({ runner, workspace, prompt: buildJudgePrompt({ question: question.question, source, candidateAnswer: answer, rubric: question.rubric }), validator: (response) => parseJudgeResponse(response, question.rubric.length), maxAttempts });
  const score = judgment.criterionResults.reduce((sum, result) => sum + question.rubric[result.criterionIndex].weight * result.score, 0);
  return { score, judgment };
}

async function diagnoseFailure({ question, source, averages, trialJudgments, stageContext, skillSource, diagnosisRoot, subjectRunner, judgeRunner, maxAttempts, skillInvocation }) {
  const skillWorkspace = path.join(diagnosisRoot, 'skill');
  const judgeWorkspace = path.join(diagnosisRoot, 'judge');
  await rm(diagnosisRoot, { recursive: true, force: true });
  await mkdir(skillWorkspace, { recursive: true });
  await mkdir(judgeWorkspace, { recursive: true });
  await copyDirectory(skillSource, path.join(skillWorkspace, '.github', 'skills', path.basename(skillSource)));
  const criterionFailures = summarizeCriterionFailures(question.rubric, trialJudgments.skill);
  const skillTrialScores = trialJudgments.skill.map((judgment) => judgment.score);
  const record = { testId: question.testId, failedCriteria: criterionFailures.map((item) => item.criterionIndex), criterionFailures, trialScores: skillTrialScores, failureStages: stageContext.stages, category: 'unknown', confidence: 0, evidence: [`closedBook score: ${averages.closedBook.toFixed(3)}`, `skill score: ${averages.skill.toFixed(3)}`, `dataset calibration score: ${averages.calibrationScore.toFixed(3)}`], diagnosticReruns: [], fixTargets: [] };
  if (Object.keys(stageContext.stages).length) record.evidence.push(`Observed failure stages: ${Object.entries(stageContext.stages).map(([stage, count]) => `${humanize(stage)} ${count}/${stageContext.trials}`).join(', ')}`);
  if (averages.calibrationScore < 1 - PERFECT_SCORE_TOLERANCE) { record.category = 'test_or_model_limitation'; record.confidence = 1; record.evidence.push('Stored dataset calibration is not fully correct.'); return record; }
  const audit = await runStructured({ runner: judgeRunner, workspace: judgeWorkspace, prompt: await buildSkillAuditPrompt({ skillPath: skillSource, question: question.question, source, stageContext }), validator: parseSkillAudit, maxAttempts });
  record.evidence.push(`Skill content audit: ${audit.rationale}`);
  if (!audit.present || !audit.complete || audit.contradictory) {
    record.category = 'skill_knowledge_gap'; record.confidence = 0.95;
    record.fixTargets = (audit.files.length ? audit.files : ['SKILL.md']).map((file) => ({ file, recommendation: audit.rationale }));
    return record;
  }
  if (skillInvocation === 'auto') {
    const forced = await subjectRunner.run(skillWorkspace, [`You must use the project skill in ${path.basename(skillSource)} to answer.`, subjectPrompt(question.question)].join('\n'));
    const forcedJudgment = await judgeAnswer({ runner: judgeRunner, workspace: judgeWorkspace, question, source, answer: forced.answer, maxAttempts });
    record.diagnosticReruns.push({ kind: 'forcedActivation', answer: forced.answer, score: forcedJudgment.score, criterionResults: forcedJudgment.judgment.criterionResults, unsupportedClaims: forcedJudgment.judgment.unsupportedClaims });
    if (forcedJudgment.score === 1) {
      record.category = 'skill_activation'; record.confidence = 0.9;
      record.fixTargets = [{ file: 'SKILL.md', recommendation: 'Improve the skill name and description so this question activates it.' }];
      return record;
    }
  }
  if (audit.files.length) {
    const direct = await subjectRunner.run(skillWorkspace, [`Use the following project skill files before answering: ${audit.files.join(', ')}`, subjectPrompt(question.question)].join('\n'));
    const directJudgment = await judgeAnswer({ runner: judgeRunner, workspace: judgeWorkspace, question, source, answer: direct.answer, maxAttempts });
    record.diagnosticReruns.push({ kind: 'directRetrieval', answer: direct.answer, score: directJudgment.score, criterionResults: directJudgment.judgment.criterionResults, unsupportedClaims: directJudgment.judgment.unsupportedClaims });
    if (directJudgment.score === 1) {
      record.category = 'skill_retrieval'; record.confidence = 0.9;
      record.fixTargets = audit.files.map((file) => ({ file, recommendation: 'Make this content easier for the skill to locate from the main instructions.' }));
      return record;
    }
  }
  const unsupported = unique(trialJudgments.skill.flatMap((judgment) => judgment.unsupportedClaims));
  if (unsupported.length) { record.category = 'grounding'; record.confidence = 0.75; record.evidence.push(`Unsupported claims: ${unsupported.join('; ')}`); }
  else if (new Set(skillTrialScores).size > 1) { record.category = 'answer_variability'; record.confidence = 1; record.evidence.push(`Skill trial scores varied from ${Math.min(...skillTrialScores).toFixed(3)} to ${Math.max(...skillTrialScores).toFixed(3)}.`); }
  else record.evidence.push('Knowledge exists and targeted reruns still failed; interpretation and application could not be isolated.');
  return record;
}

export function summarizeCriterionFailures(rubric, judgments) {
  return rubric.map((_, criterionIndex) => {
    const results = judgments.map((judgment) => judgment.criterionResults.find((result) => result.criterionIndex === criterionIndex)).filter(Boolean);
    const failed = results.filter((result) => result.score < 1);
    return {
      criterionIndex,
      averageScore: failed.length ? results.reduce((sum, result) => sum + result.score, 0) / results.length : 1,
      failedTrials: failed.length,
      totalTrials: results.length,
      rationales: unique(failed.map((result) => result.rationale)),
    };
  }).filter((result) => result.failedTrials > 0);
}

function unique(values) {
  return [...new Set(values)];
}

function assertEvaluationIsolation(closedSkills, skillSkills) {
  for (const [name, skills] of [['closed-book', closedSkills], ['skill', skillSkills]]) {
    const unexpected = skills.filter((item) => ['personal', 'plugin'].includes(item.source)).map((item) => String(item.name)).sort();
    if (unexpected.length) throw new EvaluationError(`${name} workspace exposes unexpected skills: ${unexpected.join(', ')}`);
  }
  if (closedSkills.some((item) => item.source === 'project')) throw new EvaluationError('Closed-book workspace exposes project skills');
  if (!skillSkills.some((item) => item.source === 'project')) throw new EvaluationError('Skill workspace did not discover a project skill');
}

function assertClosedBookIsolation(skills) {
  const unexpected = skills.filter((item) => ['personal', 'plugin', 'project'].includes(item.source)).map((item) => String(item.name)).sort();
  if (unexpected.length) throw new EvaluationError(`Closed-book workspace exposes unexpected skills: ${unexpected.join(', ')}`);
}

function projectSkillCommandName(skills) {
  const projectSkills = skills.filter((item) => item.source === 'project');
  if (projectSkills.length !== 1) throw new EvaluationError(`Skill workspace must expose exactly one project skill, found ${projectSkills.length}`);
  const name = projectSkills[0].name;
  if (typeof name !== 'string' || !name.trim()) throw new EvaluationError('Project skill has no callable name');
  return name.trim();
}

function assertDatasetCalibrated(manifest) {
  const calibration = manifest.calibration;
  if (!calibration || calibration.requiredScore !== 1) throw new EvaluationError('Dataset does not contain strict oracle calibration metadata');
}

// The closed-book baseline is near-deterministic, so its trial count is not part of compatibility.
function baselineCompatibility(datasetId, settings, copilotCliVersion) {
  return { datasetId, evaluatorVersion: EVALUATOR_VERSION, copilotCliVersion, model: settings.model, judgeModel: settings.judgeModel, reasoningEffort: settings.reasoningEffort };
}

function missingBaselineError(datasetPath, baselineRoot, settings) {
  const command = baselineCreationCommand(datasetPath, baselineRoot, settings);
  return new EvaluationError(`No compatible closed-book baseline found in ${path.resolve(baselineRoot)}.\n\nRun:\n${command}`, {
    code: 'BASELINE_MISSING', command, remedy: 'Create the closed-book baseline for this dataset and model once, then rerun the evaluation.',
    details: { baselineRoot: path.resolve(baselineRoot), datasetPath, model: settings.model, judgeModel: settings.judgeModel, reasoningEffort: settings.reasoningEffort },
  });
}

function baselineCreationCommand(datasetPath, baselineRoot, settings) {
  const args = ['eval', 'baseline', '--dataset', datasetPath, '--output-dir', baselineRoot, '--model', settings.model, '--judge-model', settings.judgeModel, '--reasoning-effort', settings.reasoningEffort];
  return `npm start -- ${args.map(shellArgument).join(' ')}`;
}

function shellArgument(value) {
  return /^[A-Za-z0-9_./:@=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
