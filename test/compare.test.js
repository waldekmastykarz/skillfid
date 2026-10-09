import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { compareRuns, formatComparison } from '../src/compare.js';
import { evaluateBaseline, evaluateDataset } from '../src/evaluation.js';
import { createFakeRunner, writeDatasetFixture, writeSkill } from './helpers/fixtures.js';

const root = '.work/js-tests/compare';
afterEach(async () => rm(root, { recursive: true, force: true }));

const trace = (loaded, ...files) => ({ skillLoaded: loaded, filesRead: files.map((file) => ({ path: `.github/skills/skill/${file}`, bytes: 100 })), toolCalls: [], turns: 1, inputTokens: 1, outputTokens: 1 });

async function runWith(env, name, behavior, trials = 1) {
  const runner = createFakeRunner({ behavior });
  return evaluateDataset({ datasetPath: env.datasetPath, skillPath: env.skill, baselineRoot: env.baselineRoot, outputRoot: path.join(env.base, name), workRoot: path.join(env.base, `${name}-work`), options: { concurrency: 3, trialsPerQuestion: trials, diagnoseFailures: false }, subjectRunner: runner, judgeRunner: runner });
}

async function environment() {
  const base = path.join(root, 'env');
  const { datasetPath } = await writeDatasetFixture(path.join(base, 'datasets'));
  const skill = await writeSkill(path.join(base, 'skill'));
  const env = { base, datasetPath, skill, baselineRoot: path.join(base, 'baselines') };
  const runner = createFakeRunner();
  await evaluateBaseline({ datasetPath, outputRoot: env.baselineRoot, workRoot: path.join(base, 'bw'), options: { concurrency: 2 }, subjectRunner: runner, judgeRunner: runner });
  return env;
}

test('compares two runs question by question and judges the mean delta', async () => {
  const env = await environment();
  const baseRun = await runWith(env, 'base', (question, { kind }) => {
    if (kind !== 'skill') return {};
    if (question === 'What is the size limit?') return { answer: 'wrong', trace: trace(false) };
    if (question === 'How long is data kept?') return { answer: 'wrong', trace: trace(true, 'SKILL.md') };
    if (question === 'How often do keys rotate?') return { trace: trace(true, 'SKILL.md') };
    return { trace: trace(true, 'SKILL.md') };
  });
  const headRun = await runWith(env, 'head', (question, { kind }) => {
    if (kind !== 'skill') return {};
    if (question === 'How often do keys rotate?') return { answer: 'wrong', trace: trace(true, 'SKILL.md', 'references/facts.md') };
    return { trace: trace(true, 'SKILL.md', 'references/facts.md') };
  });

  const result = await compareRuns({ basePath: baseRun, headPath: headRun, datasetPath: env.datasetPath });

  assert.equal(result.questions.compared, 5);
  assert.deepEqual(result.counts, { improved: 2, regressed: 1, unchanged: 2 });
  assert.deepEqual(result.improved.map((row) => row.question), ['What is the size limit?', 'How long is data kept?']);
  assert.equal(result.regressed[0].question, 'How often do keys rotate?');
  assert.equal(result.regressed[0].delta, -1);
  assert.equal(result.regressed[0].baseStage, null);
  assert.equal(result.regressed[0].headStage, 'application_error');
  assert.ok(Math.abs(result.meanDelta.mean - 0.2) < 1e-12);
  assert.equal(result.verdict, 'no significant change');
  assert.equal(result.base.score, 0.6);
  assert.equal(result.head.score, 0.8);
  assert.ok(result.stageChanges.some((change) => change.from === 'not_discovered' && change.to === null));
  assert.ok(Math.abs(result.progressiveDisclosure.delta.skillLoadedRate - 0.2) < 1e-12);
  assert.ok(result.progressiveDisclosure.delta.meanFilesRead > 0);
  const text = formatComparison(result);
  assert.match(text, /Improved \/ regressed \/ unchanged  2 \/ 1 \/ 2/);
  assert.match(text, /Verdict +no significant change/);
  assert.match(text, /Regressed:[\s\S]*How often do keys rotate\?/);
});

test('reports a significant regression and rejects mismatched datasets', async () => {
  const env = await environment();
  const good = await runWith(env, 'good', () => ({}));
  const bad = await runWith(env, 'bad', (_, { kind }) => (kind === 'skill' ? { answer: 'wrong' } : {}));
  const result = await compareRuns({ basePath: good, headPath: bad, datasetPath: env.datasetPath });
  assert.equal(result.verdict, 'regressed');
  assert.equal(result.counts.regressed, 5);
  assert.equal((await compareRuns({ basePath: good, headPath: good, datasetPath: env.datasetPath })).verdict, 'no significant change');
  const other = await writeDatasetFixture(path.join(root, 'other'), [{ key: 'limit', type: 'fact', difficulty: 'easy', importance: 'high', quote: 'The limit is two gigabytes.', question: 'What is the size limit?', expected: 'two gigabytes' }]);
  await assert.rejects(compareRuns({ basePath: good, headPath: bad, datasetPath: other.datasetPath }), (error) => error.code === 'COMPARE_INVALID' && /not ds_/.test(error.message));
});

test('compares only the questions both runs evaluated', async () => {
  const env = await environment();
  const full = await runWith(env, 'full', () => ({}));
  const runner = createFakeRunner();
  const subset = await evaluateDataset({ datasetPath: env.datasetPath, skillPath: env.skill, baselineRoot: env.baselineRoot, outputRoot: path.join(env.base, 'subset'), workRoot: path.join(env.base, 'subset-work'), options: { trialsPerQuestion: 1, sample: 2, seed: 1, diagnoseFailures: false }, subjectRunner: runner, judgeRunner: runner });
  const result = await compareRuns({ basePath: full, headPath: subset, datasetPath: env.datasetPath });
  assert.equal(result.questions.compared, 2);
  assert.equal(result.questions.onlyBase, 3);
  assert.equal(result.questions.onlyHead, 0);
});
