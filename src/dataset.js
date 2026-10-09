import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { AsyncLimiter } from './concurrency.js';
import { CopilotSdkRunner } from './copilot-sdk.js';
import {
  DatasetBuildError, JUDGE_CONSENSUS_POLICY_VERSION, loadDataset, processWorkRoot, publishDataset, recalibrateQuestion, RECALIBRATION_PIPELINE_VERSION,
  settleAll, waitMessage,
} from './dataset-core.js';
import { readJson, readJsonl } from './files.js';
import { stableStringify } from './json.js';
import { operationId, OperationJournal } from './journal.js';
import { ORACLE_PROMPT_VERSION } from './prompts.js';

export * from './dataset-core.js';
export { buildDataset } from './dataset-build.js';
export { estimateDatasetCalls } from './dataset-progress.js';

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
  let journal;
  let activeOperationId;
  try {
    const copilotVersion = await baseRunner.version();
    progress?.({ type: 'update', workflow: 'recalibration', current: `Running oracle and judge · Copilot CLI ${dataset.manifest.copilotCliVersion} → ${copilotVersion}`, progress: { done: 0, total: dataset.questions.length, label: 'existing questions' } });
    const operationInputs = { sourceDatasetId: dataset.datasetId, pipelineVersion: RECALIBRATION_PIPELINE_VERSION, oraclePromptVersion: ORACLE_PROMPT_VERSION, judgeConsensusPolicyVersion: JUDGE_CONSENSUS_POLICY_VERSION, copilotVersion, model: settings.model, judgeModel: settings.judgeModel, reasoningEffort: settings.reasoningEffort, maxAttempts: settings.maxAttempts };
    const baseOperationId = operationId('recalibration', operationInputs);
    const journalPath = path.resolve(workRoot, 'operations.sqlite');
    journal = await OperationJournal.open(journalPath);
    activeOperationId = settings.resume ? journal.findResumableOperation('recalibration', operationInputs)?.operationId ?? baseOperationId : `${baseOperationId}_${randomUUID().slice(0, 8)}`;
    journal.startOperation({ operationId: activeOperationId, kind: 'recalibration', inputs: operationInputs, config: { concurrency: settings.concurrency, timeoutRetries: settings.timeoutRetries, fresh: !settings.resume } });
    journal.acquireOperationLock(activeOperationId);
    progress?.({ type: 'operation', workflow: 'recalibration', message: `Recalibration operation ${activeOperationId}; concurrency ${settings.concurrency}; journal ${journalPath}`, details: { operationId: activeOperationId, concurrency: settings.concurrency, journalPath } });
    const evidenceById = new Map(evidence.map((item) => [item.evidenceId, item]));
    const documentById = new Map(documents.map((item) => [item.documentId, item.content]));
    const previousCalibration = new Map(dataset.calibrations.map((item) => [item.testId, item]));
    const limiter = new AsyncLimiter(settings.concurrency);
    let completed = 0;
    const tasks = dataset.questions.map((question) => limiter.run(async () => {
      const documentIds = [...new Set(question.evidenceIds.map((id) => evidenceById.get(id).documentId))].sort();
      const sources = documentIds.map((id) => documentById.get(id));
      const job = journal.ensureJob({ operationId: activeOperationId, stage: 'calibration', entityId: question.testId, label: `question ${question.testId}: ${question.question.slice(0, 80)}`, inputs: { question, sources, model: settings.model, judgeModel: settings.judgeModel, reasoningEffort: settings.reasoningEffort, pipelineVersion: RECALIBRATION_PIPELINE_VERSION } });
      if (job.status === 'completed') {
        completed += 1;
        progress?.({ type: 'update', workflow: 'recalibration', current: 'Restoring completed calibration from this operation', progress: { done: completed, total: dataset.questions.length, label: 'existing questions' } });
        return job.output;
      }
      const { output } = await journal.executeJob(job, async ({ attempt }) => {
        const workspace = path.join(runWork, 'questions', question.testId);
        await mkdir(workspace, { recursive: true });
        const calibration = await recalibrateQuestion({ runner: baseRunner, judgeRunner: baseJudge, workspace, question, sources, maxAttempts: settings.maxAttempts, generationAttempt: previousCalibration.get(question.testId)?.generationAttempt ?? 1, oracleAttempt: attempt });
        const result = { ...calibration, runtime: { copilotCliVersion: copilotVersion, model: settings.model, judgeModel: settings.judgeModel, reasoningEffort: settings.reasoningEffort, oraclePromptVersion: ORACLE_PROMPT_VERSION } };
        if (result.judgeConsensus?.verdict !== 'pass' || result.score !== 1 || result.integrity?.passed !== true) {
          const failedCriteria = result.criterionResults.filter((item) => item.score !== 1).map((item) => item.criterionIndex);
          const integrity = Object.fromEntries(['directlyEntailed', 'contradictionChecked', 'qualificationsIncluded', 'authorityResolved', 'proxyAnswer', 'passed'].map((field) => [field, result.integrity?.[field]]));
          const failedRationales = result.criterionResults.filter((item) => item.score !== 1).map((item) => `${item.criterionIndex}:${item.rationale}`);
          throw new DatasetBuildError(`Question ${question.testId} did not retain stable perfect oracle calibration: consensus=${result.judgeConsensus?.verdict}; votes=${result.judgeConsensus?.passVotes}/${result.judgeConsensus?.totalJudgments}; score=${result.score}; failedCriteria=${failedCriteria.join(',') || 'none'}; criterionRationales=${stableStringify(failedRationales)}; integrity=${stableStringify(integrity)}; integrityRationale=${JSON.stringify(result.integrity?.rationale)}`);
        }
        return result;
      }, { onWait: (wait) => progress?.({ type: 'update', workflow: 'recalibration', current: waitMessage(wait) }) });
      completed += 1;
      progress?.({ type: 'update', workflow: 'recalibration', current: 'Checking existing questions against the new runtime', progress: { done: completed, total: dataset.questions.length, label: 'existing questions' } });
      return output;
    }));
    const calibrations = await settleAll(tasks);
    journal.assertAllJobsCompleted(activeOperationId);
    const destination = await publishDataset({
      outputRoot, documents, sections: Array.from({ length: coverage.sections }), items: knowledge, evidence,
      questions: dataset.questions, verifications, calibrations: Object.fromEntries(calibrations.map((item) => [item.testId, item])),
      audits: audit.sections, options: settings, copilotVersion, sourceDatasetId: dataset.datasetId,
      scope: coverage.importanceTiers ? { importance: coverage.importanceTiers, excludedItems: coverage.excludedItems } : {},
    });
    journal.completeOperation(activeOperationId, destination);
    progress?.({ type: 'complete', workflow: 'recalibration', title: 'Dataset recalibrated without extraction', summary: [`${dataset.questions.length} existing questions passed oracle calibration`, `Copilot CLI ${dataset.manifest.copilotCliVersion} → ${copilotVersion}`, `New dataset ${path.basename(destination)} · source ${dataset.datasetId}`], output: destination });
    return destination;
  } catch (error) {
    if (journal && activeOperationId) journal.failOperation(activeOperationId, error);
    throw error;
  } finally {
    journal?.close();
    if (generatedRunner) await baseRunner.close();
    if (generatedJudge) await baseJudge.close();
    await rm(runWork, { recursive: true, force: true });
  }
}
