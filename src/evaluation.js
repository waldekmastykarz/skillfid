import { randomUUID } from 'node:crypto';
import { access, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { assertBaselineCoverage, findCompatibleBaseline, writeBaseline } from './baseline.js';
import { AsyncLimiter, mapConcurrent } from './concurrency.js';
import { CopilotSdkRunner } from './copilot-sdk.js';
import { loadDataset } from './dataset.js';
import { buildSkillAuditPrompt, parseSkillAudit } from './diagnosis.js';
import { copyDirectory, hashDirectory, writeJson, writeJsonl } from './files.js';
import { buildJudgePrompt, parseJudgeResponse } from './judge.js';
import { operationId, OperationJournal } from './journal.js';
import { skillPrompt, subjectPrompt } from './prompts.js';
import { runStructured } from './structured.js';

export class EvaluationError extends Error {}
const PERFECT_SCORE_TOLERANCE = 1e-9;
const SKILL_INVOCATION_MODES = new Set(['auto', 'explicit']);
export const EVALUATOR_VERSION = '0.8.0';

export async function evaluateDataset({ datasetPath, skillPath, baselineRoot = 'baselines', outputRoot = 'runs', workRoot = '.work/eval', options = {}, subjectRunner, judgeRunner, progress }) {
  const settings = { model: undefined, judgeModel: undefined, reasoningEffort: undefined, skillInvocation: 'auto', trialsPerQuestion: 3, maxAiCredits: 100, timeoutSeconds: 600, timeoutRetries: 1, maxAttempts: 2, diagnoseFailures: true, concurrency: 10, resume: true, ...options };
  if (!Number.isInteger(settings.trialsPerQuestion) || settings.trialsPerQuestion < 1) throw new Error('trialsPerQuestion must be at least 1');
  if (!SKILL_INVOCATION_MODES.has(settings.skillInvocation)) throw new Error(`skillInvocation must be one of: ${[...SKILL_INVOCATION_MODES].join(', ')}`);
  progress?.({ type: 'start', workflow: 'evaluation', title: 'Evaluating skill', current: 'Reading calibrated questions', progress: { done: 0, total: 0, label: 'questions evaluated' } });
  const dataset = await loadDataset(datasetPath);
  settings.model ??= dataset.manifest.calibration.model;
  settings.judgeModel ??= dataset.manifest.calibration.judgeModel;
  settings.reasoningEffort ??= dataset.manifest.calibration.reasoningEffort;
  assertDatasetCalibrated(dataset.manifest);
  const dashboard = { questions: dataset.questions.length, trials: settings.trialsPerQuestion, completed: 0, completedQuestions: 0, freshQuestions: 0, resumed: 0, diagnoses: 0, answering: 0, judging: 0, diagnosing: 0, trackCalls: false, limiter: undefined, scores: { closedBook: [], skill: [] } };
  progress?.({ type: 'update', workflow: 'evaluation', title: 'Evaluating skill', current: 'Preparing isolated workspaces', progress: evaluationProgress(dashboard) });
  const skillSource = path.resolve(skillPath);
  try { await access(path.join(skillSource, 'SKILL.md')); } catch { throw new EvaluationError(`Skill directory has no SKILL.md: ${skillPath}`); }

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
  const limiter = new AsyncLimiter(settings.concurrency, () => {
    if (dashboard.trackCalls) progress?.({ type: 'update', workflow: 'evaluation', current: evaluationAction(dashboard), progress: evaluationProgress(dashboard) });
  });
  dashboard.limiter = limiter;
  const baseSubject = subjectRunner ?? new CopilotSdkRunner({ model: settings.model, reasoningEffort: settings.reasoningEffort, timeoutSeconds: settings.timeoutSeconds, maxTimeoutRetries: settings.timeoutRetries, isolatedHome: path.join(home, 'subject'), progress });
  const baseJudge = judgeRunner ?? new CopilotSdkRunner({ model: settings.judgeModel, reasoningEffort: settings.reasoningEffort, timeoutSeconds: settings.timeoutSeconds, maxTimeoutRetries: settings.timeoutRetries, isolatedHome: path.join(home, 'judge'), progress });
  const answers = [];
  const judgments = [];
  const diagnoses = [];
  const evidenceById = new Map(dataset.evidence.map((item) => [item.evidenceId, item]));
  let journal;
  try {
    progress?.({ type: 'update', workflow: 'evaluation', current: 'Checking skill isolation', progress: evaluationProgress(dashboard) });
    const closedSkills = await baseSubject.listSkills(closedWorkspace);
    const skillSkills = await baseSubject.listSkills(skillWorkspace);
    assertEvaluationIsolation(closedSkills, skillSkills);
    const projectSkillName = projectSkillCommandName(skillSkills);
    const copilotCliVersion = await baseSubject.version();
    const compatibility = baselineCompatibility(dataset.datasetId, settings, copilotCliVersion);
    const baseline = await findCompatibleBaseline({ outputRoot: baselineRoot, compatibility });
    if (!baseline) throw new EvaluationError(`No compatible closed-book baseline found in ${path.resolve(baselineRoot)}.\n\nRun:\n${baselineCreationCommand(datasetPath, baselineRoot, settings)}`);
    assertBaselineCoverage(baseline, dataset.questions, settings.trialsPerQuestion);
    const skillHash = await hashDirectory(skillSource);
    const operationInputs = { datasetId: dataset.datasetId, baselineId: baseline.manifest.baselineId, skillHash, evaluatorVersion: EVALUATOR_VERSION, copilotCliVersion, model: settings.model, judgeModel: settings.judgeModel, reasoningEffort: settings.reasoningEffort, skillInvocation: settings.skillInvocation, trialsPerQuestion: settings.trialsPerQuestion, diagnoseFailures: settings.diagnoseFailures };
    const baseOperationId = operationId('evaluation', operationInputs);
    const journalPath = path.resolve(workRoot, 'operations.sqlite');
    journal = await OperationJournal.open(journalPath);
    const activeOperationId = settings.resume ? journal.findResumableOperation('evaluation', operationInputs)?.operationId ?? baseOperationId : `${baseOperationId}_${randomUUID().slice(0, 8)}`;
    journal.startOperation({ operationId: activeOperationId, kind: 'evaluation', inputs: operationInputs, config: { concurrency: settings.concurrency, timeoutRetries: settings.timeoutRetries, fresh: !settings.resume } });
    progress?.({ type: 'operation', workflow: 'evaluation', message: `Evaluation operation ${activeOperationId}; concurrency ${settings.concurrency}; journal ${journalPath}`, details: { operationId: activeOperationId, concurrency: settings.concurrency, journalPath } });
    dashboard.trackCalls = true;
    progress?.({ type: 'update', workflow: 'evaluation', current: 'Starting question evaluations', progress: evaluationProgress(dashboard) });
    const conditionPipelinesPerQuestion = settings.trialsPerQuestion * 2;
    const schedulingWindow = settings.concurrency + settings.trialsPerQuestion;
    const baselineJudgments = new Map(baseline.judgments.map((judgment) => [`${judgment.testId}:${judgment.trial}`, judgment]));
    const questionStates = new Map(dataset.questions.map((question) => {
      const calibration = dataset.calibrations.find((item) => item.testId === question.testId);
      const documentIds = [...new Set(question.evidenceIds.map((id) => evidenceById.get(id).documentId))].sort();
      const conditionResults = baseline.answers.filter((answer) => answer.testId === question.testId).map((answer) => ({ answer, judgment: baselineJudgments.get(`${answer.testId}:${answer.trial}`), reused: true }));
      return [question.testId, { question, calibration, source: documentIds.map((id) => dataset.documents[id]), conditionResults, diagnosis: undefined }];
    }));
    const conditionUnits = dataset.questions.flatMap((question) => Array.from({ length: settings.trialsPerQuestion }, (_, trial) => ({ question, trial, condition: 'skill', prompt: skillPrompt(question.question, settings.skillInvocation, projectSkillName) })));
    const diagnosisTasks = [];
    let asynchronousFailure;
    try {
      await mapConcurrent(conditionUnits, schedulingWindow, async ({ question, trial, condition, prompt }) => {
        if (asynchronousFailure) throw asynchronousFailure;
        const state = questionStates.get(question.testId);
        const output = await limiter.run(() => runConditionPipeline({ journal, operationId: activeOperationId, runWork, question, trial, condition, prompt, source: state.source, skillSource, subjectRunner: baseSubject, judgeRunner: baseJudge, maxAttempts: settings.maxAttempts, progress, dashboard }));
        state.conditionResults.push(output);
        if (state.conditionResults.length !== conditionPipelinesPerQuestion) return;
        const conditionScores = { closedBook: [], skill: [] };
        const trialAnswers = { closedBook: [], skill: [] };
        const trialJudgments = { closedBook: [], skill: [] };
        for (const result of state.conditionResults) {
          conditionScores[result.answer.condition].push(result.answer.score);
          trialAnswers[result.answer.condition].push(result.answer);
          trialJudgments[result.judgment.condition].push(result.judgment);
        }
        for (const conditionName of Object.keys(trialAnswers)) {
          trialAnswers[conditionName].sort((left, right) => left.trial - right.trial);
          trialJudgments[conditionName].sort((left, right) => left.trial - right.trial);
        }
        const averages = { ...Object.fromEntries(Object.entries(conditionScores).map(([conditionName, scores]) => [conditionName, scores.reduce((sum, score) => sum + score, 0) / scores.length])), calibrationScore: state.calibration.score };
        let diagnosisTask = Promise.resolve(undefined);
        if (averages.skill < 1 - PERFECT_SCORE_TOLERANCE && settings.diagnoseFailures) {
          diagnosisTask = limiter.run(async () => {
            dashboard.diagnosing += 1;
            progress?.({ type: 'update', workflow: 'evaluation', current: evaluationAction(dashboard), progress: evaluationProgress(dashboard) });
            try { return await runDiagnosisJob({ journal, operationId: activeOperationId, question, source: state.source, averages, trialAnswers, trialJudgments, skillSource, diagnosisRoot: path.join(runWork, 'diagnoses', question.testId), subjectRunner: baseSubject, judgeRunner: baseJudge, maxAttempts: settings.maxAttempts, skillInvocation: settings.skillInvocation }); }
            finally { dashboard.diagnosing -= 1; }
          });
          dashboard.diagnoses += 1;
        }
        diagnosisTasks.push(diagnosisTask.then((diagnosis) => {
          state.diagnosis = diagnosis;
          dashboard.completedQuestions += 1;
          if (state.conditionResults.some((result) => !result.reused)) dashboard.freshQuestions += 1;
          progress?.({ type: 'update', workflow: 'evaluation', current: evaluationAction(dashboard), progress: evaluationProgress(dashboard) });
          return { status: 'fulfilled' };
        }, (error) => {
          asynchronousFailure ??= error;
          return { status: 'rejected', reason: error };
        }));
      });
      const diagnosisResults = await Promise.all(diagnosisTasks);
      const diagnosisFailure = diagnosisResults.find((result) => result.status === 'rejected');
      if (diagnosisFailure) throw diagnosisFailure.reason;
    }
    catch (error) {
      await Promise.all(diagnosisTasks);
      progress?.({ type: 'error', workflow: 'evaluation', message: error.message, progress: evaluationProgress(dashboard) });
      throw error;
    }
    const questionResults = dataset.questions.map((question) => {
      const state = questionStates.get(question.testId);
      return { conditionResults: state.conditionResults, diagnosis: state.diagnosis };
    });
    for (const result of questionResults) {
      for (const conditionResult of result.conditionResults) { answers.push(conditionResult.answer); judgments.push(conditionResult.judgment); }
      if (result.diagnosis) diagnoses.push(result.diagnosis);
    }
    journal.assertAllJobsCompleted(activeOperationId);
    const finalCounts = journal.jobCounts(activeOperationId);
    progress?.({ type: 'checkpoint', workflow: 'evaluation', current: 'Writing evaluation results', progress: evaluationProgress(dashboard), details: { jobs: finalCounts } });
    const resolvedOutputRoot = path.resolve(outputRoot);
    await mkdir(resolvedOutputRoot, { recursive: true });
    const destination = path.join(resolvedOutputRoot, runId);
    await mkdir(destination, { recursive: false });
    await writeJsonl(path.join(destination, 'answers.jsonl'), answers);
    await writeJsonl(path.join(destination, 'judgments.jsonl'), judgments);
    await writeJsonl(path.join(destination, 'diagnoses.jsonl'), diagnoses);
    const summary = buildSummary(dataset, answers, diagnoses);
    await writeJson(path.join(destination, 'summary.json'), summary);
    await writeJson(path.join(destination, 'manifest.json'), { runId, createdAt: new Date().toISOString(), datasetId: dataset.datasetId, baselineId: baseline.manifest.baselineId, skillHash, evaluatorVersion: EVALUATOR_VERSION, copilotCliVersion, model: settings.model, judgeModel: settings.judgeModel, reasoningEffort: settings.reasoningEffort, skillInvocation: settings.skillInvocation, trialsPerQuestion: settings.trialsPerQuestion, timeoutSeconds: settings.timeoutSeconds, timeoutRetries: settings.timeoutRetries, diagnoseFailures: settings.diagnoseFailures });
    journal.completeOperation(activeOperationId, destination);
    progress?.({ type: 'complete', workflow: 'evaluation', title: 'Evaluation complete', summary: [`Closed book ${formatScore(summary.conditionScores.closedBook)}, skill ${formatScore(summary.conditionScores.skill)}`, `Uplift ${formatSignedScore(summary.skillUplift).replace('%', ' percentage points')}`, `${formatCount(finalCounts.completed, 'job')} completed, ${finalCounts.failed} failed`], details: { destination, operationId: activeOperationId } });
    return destination;
  } finally {
    journal?.close();
    if (generatedSubject) await baseSubject.close();
    if (generatedJudge) await baseJudge.close();
    await rm(runWork, { recursive: true, force: true });
    if (generatedSubject) await rm(home, { recursive: true, force: true });
  }
}

export async function evaluateBaseline({ datasetPath, outputRoot = 'baselines', workRoot = '.work/baseline', options = {}, subjectRunner, judgeRunner, progress }) {
  const settings = { model: undefined, judgeModel: undefined, reasoningEffort: undefined, trialsPerQuestion: 3, timeoutSeconds: 600, timeoutRetries: 1, maxAttempts: 2, concurrency: 10, resume: true, ...options };
  if (!Number.isInteger(settings.trialsPerQuestion) || settings.trialsPerQuestion < 1) throw new Error('trialsPerQuestion must be at least 1');
  progress?.({ type: 'start', workflow: 'baseline', title: 'Evaluating closed-book baseline', current: 'Reading calibrated questions', progress: { done: 0, total: 0, label: 'questions evaluated' } });
  const dataset = await loadDataset(datasetPath);
  settings.model ??= dataset.manifest.calibration.model;
  settings.judgeModel ??= dataset.manifest.calibration.judgeModel;
  settings.reasoningEffort ??= dataset.manifest.calibration.reasoningEffort;
  assertDatasetCalibrated(dataset.manifest);
  const dashboard = { questions: dataset.questions.length, trials: settings.trialsPerQuestion, completed: 0, completedQuestions: 0, freshQuestions: 0, resumed: 0, diagnoses: 0, answering: 0, judging: 0, diagnosing: 0, trackCalls: false, limiter: undefined, scores: { closedBook: [] } };
  const workId = `baseline_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const runWork = path.resolve(workRoot, workId);
  const home = path.join(runWork, 'home');
  const closedWorkspace = path.join(runWork, 'isolation-check', 'closed');
  await mkdir(closedWorkspace, { recursive: true });
  const generatedSubject = !subjectRunner;
  const generatedJudge = !judgeRunner;
  const limiter = new AsyncLimiter(settings.concurrency, () => {
    if (dashboard.trackCalls) progress?.({ type: 'update', workflow: 'baseline', current: evaluationAction(dashboard), progress: evaluationProgress(dashboard) });
  });
  dashboard.limiter = limiter;
  const baseSubject = subjectRunner ?? new CopilotSdkRunner({ model: settings.model, reasoningEffort: settings.reasoningEffort, timeoutSeconds: settings.timeoutSeconds, maxTimeoutRetries: settings.timeoutRetries, isolatedHome: path.join(home, 'subject'), progress });
  const baseJudge = judgeRunner ?? new CopilotSdkRunner({ model: settings.judgeModel, reasoningEffort: settings.reasoningEffort, timeoutSeconds: settings.timeoutSeconds, maxTimeoutRetries: settings.timeoutRetries, isolatedHome: path.join(home, 'judge'), progress });
  let journal;
  try {
    assertClosedBookIsolation(await baseSubject.listSkills(closedWorkspace));
    const copilotCliVersion = await baseSubject.version();
    const compatibility = baselineCompatibility(dataset.datasetId, settings, copilotCliVersion);
    const operationInputs = compatibility;
    const baseOperationId = operationId('baseline', operationInputs);
    const journalPath = path.resolve(workRoot, 'operations.sqlite');
    journal = await OperationJournal.open(journalPath);
    const activeOperationId = settings.resume ? journal.findResumableOperation('baseline', operationInputs)?.operationId ?? baseOperationId : `${baseOperationId}_${randomUUID().slice(0, 8)}`;
    journal.startOperation({ operationId: activeOperationId, kind: 'baseline', inputs: operationInputs, config: { concurrency: settings.concurrency, timeoutRetries: settings.timeoutRetries, fresh: !settings.resume } });
    progress?.({ type: 'operation', workflow: 'baseline', message: `Baseline operation ${activeOperationId}; concurrency ${settings.concurrency}; journal ${journalPath}`, details: { operationId: activeOperationId, concurrency: settings.concurrency, journalPath } });
    dashboard.trackCalls = true;
    const evidenceById = new Map(dataset.evidence.map((item) => [item.evidenceId, item]));
    const units = dataset.questions.flatMap((question) => Array.from({ length: settings.trialsPerQuestion }, (_, trial) => ({ question, trial, condition: 'closedBook', prompt: subjectPrompt(question.question) })));
    const resultsByQuestion = new Map(dataset.questions.map((question) => [question.testId, 0]));
    const results = await mapConcurrent(units, settings.concurrency + settings.trialsPerQuestion, async ({ question, trial, condition, prompt }) => {
      const documentIds = [...new Set(question.evidenceIds.map((id) => evidenceById.get(id).documentId))].sort();
      const output = await limiter.run(() => runConditionPipeline({ journal, operationId: activeOperationId, runWork, question, trial, condition, prompt, source: documentIds.map((id) => dataset.documents[id]), subjectRunner: baseSubject, judgeRunner: baseJudge, maxAttempts: settings.maxAttempts, progress, dashboard }));
      const completed = resultsByQuestion.get(question.testId) + 1;
      resultsByQuestion.set(question.testId, completed);
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
    progress?.({ type: 'complete', workflow: 'baseline', title: 'Baseline complete', summary: [`Closed book ${formatScore(score)}`, `${formatCount(finalCounts.completed, 'job')} completed, ${finalCounts.failed} failed`], details: { destination, operationId: activeOperationId } });
    return destination;
  } finally {
    journal?.close();
    if (generatedSubject) await baseSubject.close();
    if (generatedJudge) await baseJudge.close();
    await rm(runWork, { recursive: true, force: true });
    if (generatedSubject) await rm(home, { recursive: true, force: true });
  }
}

async function runConditionPipeline({ journal, operationId: id, runWork, question, trial, condition, prompt, source, skillSource, subjectRunner, judgeRunner, maxAttempts, progress, dashboard }) {
  const entityId = `${question.testId}:${trial}:${condition}`;
  dashboard.answering += 1;
  progress?.({ type: 'update', workflow: 'evaluation', current: evaluationAction(dashboard), progress: evaluationProgress(dashboard) });
  let stage = 'answering';
  try {
    const workspace = path.join(runWork, 'trials', question.testId, String(trial), condition, condition === 'skill' ? 'skill' : condition);
    await mkdir(workspace, { recursive: true });
    if (condition === 'skill') await copyDirectory(skillSource, path.join(workspace, '.github', 'skills', path.basename(skillSource)));
    const answerResult = await runAnswerJob({ journal, operationId: id, entityId, question, trial, condition, prompt, workspace, subjectRunner });
    dashboard.answering -= 1; dashboard.judging += 1;
    stage = 'judging';
    progress?.({ type: 'update', workflow: 'evaluation', current: evaluationAction(dashboard), progress: evaluationProgress(dashboard) });
    const judgeWorkspace = path.join(runWork, 'trials', question.testId, String(trial), condition, 'judge');
    await mkdir(judgeWorkspace, { recursive: true });
    const judgmentResult = await runJudgmentJob({ journal, operationId: id, entityId, question, trial, condition, source, answer: answerResult.answer, workspace: judgeWorkspace, judgeRunner, maxAttempts });
    const answer = { ...answerResult.answer, score: judgmentResult.judgment.score };
    dashboard.judging -= 1; dashboard.completed += 1; dashboard.scores[condition].push(judgmentResult.judgment.score);
    stage = 'completed';
    if (answerResult.reused && judgmentResult.reused) dashboard.resumed += 1;
    return { answer, judgment: judgmentResult.judgment, reused: answerResult.reused && judgmentResult.reused };
  } catch (error) {
    if (stage === 'judging') dashboard.judging -= 1;
    else if (stage === 'answering') dashboard.answering -= 1;
    throw error;
  }
}

async function runAnswerJob({ journal, operationId, entityId, question, trial, condition, prompt, workspace, subjectRunner }) {
  const job = journal.ensureJob({ operationId, stage: 'answer', entityId, inputs: { question, trial, condition, prompt } });
  if (job.status === 'completed') return { answer: job.output, reused: true };
  return runJournalJob({ journal, job, label: `answer job ${entityId}`, run: async () => {
    const result = await subjectRunner.run(workspace, prompt);
    return { testId: question.testId, trial, condition, answer: result.answer, durationSeconds: result.durationSeconds };
  }, resultKey: 'answer' });
}

async function runJudgmentJob({ journal, operationId, entityId, question, trial, condition, source, answer, workspace, judgeRunner, maxAttempts }) {
  const job = journal.ensureJob({ operationId, stage: 'judgment', entityId, inputs: { question, trial, condition, source, answer } });
  if (job.status === 'completed') return { judgment: job.output, reused: true };
  return runJournalJob({ journal, job, label: `judgment job ${entityId}`, run: async () => {
    const { score, judgment } = await judgeAnswer({ runner: judgeRunner, workspace, question, source, answer: answer.answer, maxAttempts });
    return { testId: question.testId, trial, condition, criterionResults: judgment.criterionResults, unsupportedClaims: judgment.unsupportedClaims, score };
  }, resultKey: 'judgment' });
}

async function runJournalJob({ journal, job, label, run, resultKey }) {
  const workerId = randomUUID();
  if (!journal.claimJob(job.jobId, workerId)) throw new EvaluationError(`Could not claim ${label}`);
  const lease = setInterval(() => journal.renewLease(job.jobId, workerId), 5 * 60 * 1000);
  lease.unref();
  try {
    const output = await run();
    journal.completeJob(job.jobId, workerId, output);
    return { [resultKey]: output, reused: false };
  } catch (error) {
    journal.failJob(job.jobId, workerId, error);
    throw error;
  } finally { clearInterval(lease); }
}

async function runDiagnosisJob({ journal, operationId: id, question, ...inputs }) {
  const job = journal.ensureJob({ operationId: id, stage: 'diagnosis', entityId: question.testId, inputs: { question, averages: inputs.averages, trialAnswers: inputs.trialAnswers, trialJudgments: inputs.trialJudgments, skillInvocation: inputs.skillInvocation } });
  if (job.status === 'completed') return job.output;
  const workerId = randomUUID();
  if (!journal.claimJob(job.jobId, workerId)) throw new EvaluationError(`Could not claim diagnosis job ${question.testId}`);
  const lease = setInterval(() => journal.renewLease(job.jobId, workerId), 5 * 60 * 1000);
  lease.unref();
  try { const output = await diagnoseFailure({ question, ...inputs }); journal.completeJob(job.jobId, workerId, output); return output; }
  catch (error) { journal.failJob(job.jobId, workerId, error); throw error; }
  finally { clearInterval(lease); }
}

async function settleAll(promises) {
  const settled = await Promise.allSettled(promises);
  const failure = settled.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  return settled.map((result) => result.value);
}

function evaluationProgress(state) {
  return { done: state.completedQuestions, total: state.questions, etaDone: state.freshQuestions, label: 'questions evaluated' };
}

function evaluationAction(state) {
  const actions = [];
  if (state.limiter?.stats.queued) actions.push(`${formatCount(state.limiter.stats.queued, 'job')} queued`);
  if (state.answering) actions.push(`${formatCount(state.answering, 'answer')} in progress`);
  if (state.judging) actions.push(`${formatCount(state.judging, 'judgment')} in progress`);
  if (state.diagnosing) actions.push(`${formatCount(state.diagnosing, 'diagnosis', 'diagnoses')} in progress`);
  if (!actions.length && state.resumed) return `Reused ${formatCount(state.resumed, 'completed evaluation')}`;
  return actions.join(' · ') || 'Preparing evaluations';
}

function averageScore(scores) {
  return scores.length ? formatScore(scores.reduce((sum, score) => sum + score, 0) / scores.length) : '--';
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

async function diagnoseFailure({ question, source, averages, trialJudgments, skillSource, diagnosisRoot, subjectRunner, judgeRunner, maxAttempts, skillInvocation }) {
  const skillWorkspace = path.join(diagnosisRoot, 'skill');
  const judgeWorkspace = path.join(diagnosisRoot, 'judge');
  await mkdir(skillWorkspace, { recursive: true });
  await mkdir(judgeWorkspace, { recursive: true });
  await copyDirectory(skillSource, path.join(skillWorkspace, '.github', 'skills', path.basename(skillSource)));
  const criterionFailures = summarizeCriterionFailures(question.rubric, trialJudgments.skill);
  const skillTrialScores = trialJudgments.skill.map((judgment) => judgment.score);
  const record = { testId: question.testId, failedCriteria: criterionFailures.map((item) => item.criterionIndex), criterionFailures, trialScores: skillTrialScores, category: 'unknown', confidence: 0, evidence: [`closedBook score: ${averages.closedBook.toFixed(3)}`, `skill score: ${averages.skill.toFixed(3)}`, `dataset calibration score: ${averages.calibrationScore.toFixed(3)}`], diagnosticReruns: [], fixTargets: [] };
  if (averages.calibrationScore < 1 - PERFECT_SCORE_TOLERANCE) { record.category = 'test_or_model_limitation'; record.confidence = 1; record.evidence.push('Stored dataset calibration is not fully correct.'); return record; }
  const audit = await runStructured({ runner: judgeRunner, workspace: judgeWorkspace, prompt: await buildSkillAuditPrompt({ skillPath: skillSource, question: question.question, source }), validator: parseSkillAudit, maxAttempts });
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

function baselineCompatibility(datasetId, settings, copilotCliVersion) {
  return { datasetId, evaluatorVersion: EVALUATOR_VERSION, copilotCliVersion, model: settings.model, judgeModel: settings.judgeModel, reasoningEffort: settings.reasoningEffort, trialsPerQuestion: settings.trialsPerQuestion };
}

function baselineCreationCommand(datasetPath, baselineRoot, settings) {
  const args = ['eval', 'baseline', '--dataset', datasetPath, '--output-dir', baselineRoot, '--model', settings.model, '--judge-model', settings.judgeModel, '--reasoning-effort', settings.reasoningEffort, '--trials', String(settings.trialsPerQuestion)];
  return `npm start -- ${args.map(shellArgument).join(' ')}`;
}

function shellArgument(value) {
  return /^[A-Za-z0-9_./:@=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function buildSummary(dataset, answers, diagnoses) {
  const grouped = {};
  for (const answer of answers) (grouped[answer.condition] ??= []).push(answer.score);
  const conditionScores = Object.fromEntries(Object.entries(grouped).map(([condition, scores]) => [condition, scores.reduce((sum, score) => sum + score, 0) / scores.length]));
  const datasetCeiling = dataset.calibrations.reduce((sum, item) => sum + item.score, 0) / dataset.calibrations.length;
  return { datasetId: dataset.datasetId, questions: dataset.questions.length, conditionScores, datasetCeiling, skillUplift: conditionScores.skill - conditionScores.closedBook, diagnosedFailures: diagnoses.length };
}

function formatJobCounts(counts) { return `completed ${counts.completed}, running ${counts.running}, pending ${counts.pending}, failed ${counts.failed}`; }