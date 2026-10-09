import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { buildCalibrationPrompt, parseCalibrationResponse } from './calibration.js';
import { corpusRevision } from './corpus.js';
import { EXIT_CODES, SkillfidError } from './errors.js';
import { readJson, readJsonl, writeJson, writeJsonl } from './files.js';
import { stableStringify } from './json.js';
import { ORACLE_PROMPT_VERSION, oraclePrompt } from './prompts.js';
import { runStructured } from './structured.js';

export const DATASET_SCHEMA_VERSION = 6;
export const DATASET_PIPELINE_VERSION = '0.5.0';
export const RECALIBRATION_PIPELINE_VERSION = '0.5.7';
export const JUDGE_CONSENSUS_POLICY_VERSION = '1';
export const INITIAL_JUDGMENTS = 3;
export const DISAGREEMENT_JUDGMENTS = 2;
export const SUPERMAJORITY_VOTES = 4;
export const IMPORTANCE_PROFILES = Object.freeze({ full: ['high', 'medium', 'low'], standard: ['high', 'medium'], quick: ['high'] });

export class DatasetBuildError extends SkillfidError {
  constructor(message, options = {}) { super(message, { code: 'DATASET_BUILD', exitCode: EXIT_CODES.failure, ...options }); }
}

// Scratch space is per process so concurrent runs sharing a work directory cannot delete each other's files.
export function processWorkRoot(workRoot, kind) {
  return path.resolve(workRoot, `${kind}_${randomUUID().replaceAll('-', '').slice(0, 16)}`);
}

export async function calibrateQuestion({ runner, judgeRunner, workspace, question, source, maxAttempts, generationAttempt }) {
  const oracle = await runner.run(workspace, oraclePrompt(question.question, [source]));
  const judged = await judgeWithConsensus({ judgeRunner, workspace: path.join(workspace, 'judgments'), question, sources: [source], answer: oracle.answer, maxAttempts });
  return { testId: question.testId, answer: oracle.answer, ...judged, generationAttempt, oracleAttempts: 1 };
}

export async function recalibrateQuestion({ runner, judgeRunner, workspace, question, sources, maxAttempts, generationAttempt, oracleAttempt }) {
  await Promise.all([mkdir(path.join(workspace, 'oracle'), { recursive: true }), mkdir(path.join(workspace, 'judge'), { recursive: true })]);
  const oracle = await runner.run(path.join(workspace, 'oracle'), oraclePrompt(question.question, sources, question.rubric));
  const judged = await judgeWithConsensus({ judgeRunner, workspace: path.join(workspace, 'judge'), question, sources, answer: oracle.answer, maxAttempts });
  return { testId: question.testId, answer: oracle.answer, ...judged, generationAttempt, oracleAttempts: oracleAttempt };
}

// Independent judgments run in parallel; the extra tie-break judgments only run when the first three disagree.
export async function judgeWithConsensus({ judgeRunner, workspace, question, sources, answer, maxAttempts }) {
  const prompt = buildCalibrationPrompt({ question: question.question, source: sources, candidateAnswer: answer, rubric: question.rubric });
  const runJudgment = async (index) => {
    const judgmentWorkspace = path.join(workspace, `judgment-${index + 1}`);
    await mkdir(judgmentWorkspace, { recursive: true });
    const judgment = await runStructured({ runner: judgeRunner, workspace: judgmentWorkspace, prompt, validator: (response) => parseCalibrationResponse(response, question.rubric.length), maxAttempts });
    // Weights that sum to 1 only approximately must not turn a perfect answer into 0.9999999999999999.
    const score = Math.round(judgment.criterionResults.reduce((sum, result) => sum + question.rubric[result.criterionIndex].weight * result.score, 0) * 1e9) / 1e9;
    return { ...judgment, score, passed: judgmentPassed({ ...judgment, score }) };
  };
  const judgments = await Promise.all(Array.from({ length: INITIAL_JUDGMENTS }, (_, index) => runJudgment(index)));
  if (!judgments.every((judgment) => judgment.passed === judgments[0].passed)) {
    judgments.push(...await Promise.all(Array.from({ length: DISAGREEMENT_JUDGMENTS }, (_, index) => runJudgment(INITIAL_JUDGMENTS + index))));
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

export async function settleAll(promises) {
  const settled = await Promise.allSettled(promises);
  const failure = settled.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  return settled.map((result) => result.value);
}

export function assertCompleteCoverage(items, questions) {
  const covered = new Set(questions.flatMap((question) => question.rubric.flatMap((criterion) => criterion.knowledgeItemIds)));
  const missing = items.map((item) => item.knowledgeId).filter((id) => !covered.has(id)).sort();
  if (missing.length) throw new DatasetBuildError(`Dataset does not cover accepted knowledge items: ${missing.join(', ')}`);
}

export async function publishDataset({ outputRoot, documents, sections, items, evidence, questions, verifications, calibrations, audits, options, copilotVersion, sourceDatasetId, scope = {} }) {
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
    await writeJson(path.join(staging, 'coverage.json'), { acceptedItems: items.length, coveredItems: items.length, coverage: 1, sections: sections.length, informationalSections: new Set(items.map((item) => item.sectionId)).size, ...(scope.importance ? { importanceTiers: scope.importance, excludedItems: scope.excludedItems ?? 0 } : {}) });
    await writeJson(path.join(staging, 'audit.json'), { sections: audits });
    await writeJson(path.join(staging, 'verifications.json'), verifications);
    await writeJson(path.join(staging, 'manifest.json'), { schemaVersion: DATASET_SCHEMA_VERSION, datasetId, createdAt: new Date().toISOString(), ...(sourceDatasetId ? { sourceDatasetId } : {}), corpusRevision: canonicalValue.corpusRevision, extractorVersion: DATASET_PIPELINE_VERSION, copilotCliVersion: copilotVersion, model: options.model, reasoningEffort: options.reasoningEffort, timeoutSeconds: options.timeoutSeconds, timeoutRetries: options.timeoutRetries, ...(scope.importance ? { importanceTiers: scope.importance } : {}), calibration: { model: options.model, judgeModel: options.judgeModel, reasoningEffort: options.reasoningEffort, oraclePromptVersion: ORACLE_PROMPT_VERSION, judgeConsensus: { policyVersion: JUDGE_CONSENSUS_POLICY_VERSION, initialJudgments: INITIAL_JUDGMENTS, additionalJudgmentsOnDisagreement: DISAGREEMENT_JUDGMENTS, supermajorityVotes: SUPERMAJORITY_VOTES }, requiredScore: 1 }, documentRevisions: Object.fromEntries(documents.map((document) => [document.documentId, document.revision])) });
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
  return { datasetId: manifest.datasetId, questions, evidence, knowledge, documents: documentMap, calibrations, manifest };
}

function hasValidPassingConsensus(calibration, question) {
  const judgments = calibration?.judgments;
  const consensus = calibration?.judgeConsensus;
  if (!Array.isArray(judgments) || !consensus || consensus.policyVersion !== JUDGE_CONSENSUS_POLICY_VERSION || consensus.verdict !== 'pass') return false;
  const validJudgments = judgments.every((judgment) => {
    const score = judgment.criterionResults?.reduce((sum, result) => sum + question.rubric[result.criterionIndex].weight * result.score, 0);
    return Math.abs(score - judgment.score) < 1e-9 && judgment.passed === judgmentPassed(judgment);
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

export function deduplicateEvidence(records) {
  return [...new Map(records.map((record) => [record.evidenceId, record])).values()].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId, 'en'));
}

export function sha256(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }

export function formatCount(count, singular) {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

export function waitMessage({ job, ownerPid, expiresInMs }) {
  return `Waiting for ${job.label ?? job.entityId}, leased by pid ${ownerPid ?? 'unknown'} (frees in ${Math.ceil(expiresInMs / 1000)}s)`;
}
