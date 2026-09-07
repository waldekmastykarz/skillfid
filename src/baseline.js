import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

import { readJson, readJsonl, writeJson, writeJsonl } from './files.js';
import { stableStringify } from './json.js';

export class BaselineError extends Error {}

export function baselineCompatibilityKey(compatibility) {
  return createHash('sha256').update(stableStringify(compatibility), 'utf8').digest('hex');
}

export async function writeBaseline({ outputRoot, compatibility, answers, judgments }) {
  assertBaselineRecords(answers, judgments);
  const baselineId = `baseline_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const root = path.resolve(outputRoot);
  await mkdir(root, { recursive: true });
  const destination = path.join(root, baselineId);
  await mkdir(destination, { recursive: false });
  await writeJsonl(path.join(destination, 'answers.jsonl'), answers);
  await writeJsonl(path.join(destination, 'judgments.jsonl'), judgments);
  await writeJson(path.join(destination, 'manifest.json'), {
    baselineId,
    compatibilityKey: baselineCompatibilityKey(compatibility),
    createdAt: new Date().toISOString(),
    ...compatibility,
  });
  return destination;
}

export async function findCompatibleBaseline({ outputRoot, compatibility }) {
  const root = path.resolve(outputRoot);
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  const compatibilityKey = baselineCompatibilityKey(compatibility);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('baseline_')) continue;
    const baselinePath = path.join(root, entry.name);
    const manifest = await readJson(path.join(baselinePath, 'manifest.json'));
    if (manifest.compatibilityKey === compatibilityKey) candidates.push({ baselinePath, manifest });
  }
  candidates.sort((left, right) => right.manifest.createdAt.localeCompare(left.manifest.createdAt) || right.manifest.baselineId.localeCompare(left.manifest.baselineId));
  if (!candidates.length) return undefined;
  return loadBaseline(candidates[0].baselinePath, compatibility);
}

export async function loadBaseline(baselinePath, compatibility) {
  const root = path.resolve(baselinePath);
  const [manifest, answers, judgments] = await Promise.all([
    readJson(path.join(root, 'manifest.json')),
    readJsonl(path.join(root, 'answers.jsonl')),
    readJsonl(path.join(root, 'judgments.jsonl')),
  ]);
  const expectedKey = baselineCompatibilityKey(compatibility);
  if (manifest.compatibilityKey !== expectedKey) throw new BaselineError(`Baseline ${manifest.baselineId ?? root} is not compatible with this evaluation configuration`);
  assertBaselineRecords(answers, judgments);
  return { baselinePath: root, manifest, answers, judgments };
}

export function assertBaselineCoverage({ answers, judgments }, questions, trialsPerQuestion) {
  assertBaselineRecords(answers, judgments);
  const expectedKeys = new Set(questions.flatMap((question) => Array.from({ length: trialsPerQuestion }, (_, trial) => `${question.testId}:${trial}`)));
  const answerKeys = new Set(answers.map(recordKey));
  const judgmentKeys = new Set(judgments.map(recordKey));
  if (answerKeys.size !== expectedKeys.size || [...expectedKeys].some((key) => !answerKeys.has(key) || !judgmentKeys.has(key))) {
    throw new BaselineError(`Baseline coverage does not match ${questions.length} questions with ${trialsPerQuestion} trials each`);
  }
}

function assertBaselineRecords(answers, judgments) {
  if (!answers.length || answers.some((answer) => answer.condition !== 'closedBook')) throw new BaselineError('Baseline answers must contain only closed-book records');
  if (judgments.length !== answers.length || judgments.some((judgment) => judgment.condition !== 'closedBook')) throw new BaselineError('Baseline judgments must match the closed-book answers');
  const answerKeys = new Set(answers.map(recordKey));
  if (answerKeys.size !== answers.length || judgments.some((judgment) => !answerKeys.has(recordKey(judgment)))) throw new BaselineError('Baseline answers and judgments must have matching unique test and trial records');
}

function recordKey(record) {
  return `${record.testId}:${record.trial}`;
}