import path from 'node:path';

import { loadDataset } from './dataset.js';
import { SkillfidError } from './errors.js';
import { readJson, readJsonl } from './files.js';
import { dominantStage } from './staging.js';
import { deltaVerdict, mean, meanInterval, SCORE_TOLERANCE } from './stats.js';

const DISCLOSURE_KEYS = ['meanFilesRead', 'meanBytesRead', 'meanFractionLoaded', 'loadedEverythingRate', 'skillLoadedRate'];

export class CompareError extends SkillfidError {
  constructor(message, options = {}) { super(message, { code: 'COMPARE_INVALID', ...options }); }
}

async function loadRun(runPath) {
  const root = path.resolve(runPath);
  const [manifest, summary, answers] = await Promise.all([readJson(path.join(root, 'manifest.json')), readJson(path.join(root, 'summary.json')), readJsonl(path.join(root, 'answers.jsonl'))]);
  return { root, manifest, summary, answers: answers.filter((answer) => answer.condition === 'skill') };
}

function perQuestion(answers) {
  const grouped = new Map();
  for (const answer of answers) grouped.set(answer.testId, [...(grouped.get(answer.testId) ?? []), answer]);
  return new Map([...grouped].map(([testId, items]) => [testId, { score: mean(items.map((item) => item.score)), stage: dominantStage(items) }]));
}

// Paired per-question comparison of skill scores between two runs of the same dataset.
export async function compareRuns({ basePath, headPath, datasetPath }) {
  const [dataset, base, head] = await Promise.all([loadDataset(datasetPath), loadRun(basePath), loadRun(headPath)]);
  for (const [name, run] of [['base', base], ['head', head]]) {
    if (run.manifest.datasetId !== dataset.datasetId) throw new CompareError(`The ${name} run used dataset ${run.manifest.datasetId}, not ${dataset.datasetId}.`);
  }
  const baseScores = perQuestion(base.answers);
  const headScores = perQuestion(head.answers);
  const labels = new Map(dataset.questions.map((question) => [question.testId, question.question]));
  const common = [...baseScores.keys()].filter((id) => headScores.has(id)).sort();
  if (!common.length) throw new CompareError('The two runs have no evaluated questions in common.');
  const rows = common.map((testId) => {
    const before = baseScores.get(testId);
    const after = headScores.get(testId);
    const delta = after.score - before.score;
    return { testId, question: labels.get(testId) ?? testId, base: before.score, head: after.score, delta, change: delta > SCORE_TOLERANCE ? 'improved' : delta < -SCORE_TOLERANCE ? 'regressed' : 'unchanged', baseStage: before.stage ?? null, headStage: after.stage ?? null };
  });
  const interval = meanInterval(rows.map((row) => row.delta));
  const byChange = (change) => rows.filter((row) => row.change === change);
  const disclosure = (run) => run.summary.progressiveDisclosure ?? null;
  const disclosureDelta = disclosure(base) && disclosure(head) ? Object.fromEntries(DISCLOSURE_KEYS.map((key) => [key, disclosure(base)[key] === null || disclosure(head)[key] === null ? null : disclosure(head)[key] - disclosure(base)[key]])) : null;
  return {
    datasetId: dataset.datasetId,
    base: { runId: base.manifest.runId, skillHash: base.manifest.skillHash, score: mean(rows.map((row) => row.base)) },
    head: { runId: head.manifest.runId, skillHash: head.manifest.skillHash, score: mean(rows.map((row) => row.head)) },
    questions: { compared: rows.length, onlyBase: baseScores.size - rows.length, onlyHead: headScores.size - rows.length },
    counts: { improved: byChange('improved').length, regressed: byChange('regressed').length, unchanged: byChange('unchanged').length },
    meanDelta: interval,
    verdict: deltaVerdict(interval),
    improved: byChange('improved').sort((left, right) => right.delta - left.delta),
    regressed: byChange('regressed').sort((left, right) => left.delta - right.delta),
    stageChanges: rows.filter((row) => row.baseStage !== row.headStage).map((row) => ({ testId: row.testId, question: row.question, from: row.baseStage, to: row.headStage })),
    progressiveDisclosure: { base: disclosure(base), head: disclosure(head), delta: disclosureDelta },
  };
}

const percent = (value) => (value === null || value === undefined ? '--' : `${(value * 100).toFixed(1)}%`);
const points = (value) => (value === null || value === undefined ? '--' : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)} pp`);

export function formatComparison(result) {
  const lines = [
    `Skill comparison: ${result.base.runId} → ${result.head.runId}`,
    `  Questions compared  ${result.questions.compared}${result.questions.onlyBase || result.questions.onlyHead ? ` (${result.questions.onlyBase} only in base, ${result.questions.onlyHead} only in head)` : ''}`,
    `  Skill score         ${percent(result.base.score)} → ${percent(result.head.score)}`,
    `  Mean delta          ${points(result.meanDelta.mean)}${result.meanDelta.halfWidth === null ? '' : ` (95% CI ${points(result.meanDelta.low)} to ${points(result.meanDelta.high)})`}`,
    `  Improved / regressed / unchanged  ${result.counts.improved} / ${result.counts.regressed} / ${result.counts.unchanged}`,
    `  Verdict             ${result.verdict}`,
  ];
  const list = (title, items) => items.length ? ['', `${title}:`, ...items.slice(0, 10).map((row) => `  ${points(row.delta).padStart(9)}  ${percent(row.base)} → ${percent(row.head)}  ${truncate(row.question, 70)}`), ...(items.length > 10 ? [`  … ${items.length - 10} more`] : [])] : [];
  lines.push(...list('Regressed', result.regressed), ...list('Improved', result.improved));
  if (result.stageChanges.length) lines.push('', `Failure stage changes: ${result.stageChanges.length}`, ...result.stageChanges.slice(0, 10).map((change) => `  ${change.from ?? 'perfect'} → ${change.to ?? 'perfect'}  ${truncate(change.question, 70)}`));
  const delta = result.progressiveDisclosure.delta;
  if (delta) lines.push('', 'Progressive disclosure (head minus base):', `  Files read ${signed(delta.meanFilesRead)} · fraction of skill loaded ${points(delta.meanFractionLoaded)} · loaded everything ${points(delta.loadedEverythingRate)} · skill loaded ${points(delta.skillLoadedRate)}`);
  return lines.join('\n');
}

const signed = (value) => (value === null ? '--' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}`);
const truncate = (text, length) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);
