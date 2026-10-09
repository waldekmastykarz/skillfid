import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { evaluateBaseline, evaluateDataset } from '../src/evaluation.js';
import { createFakeRunner, writeDatasetFixture, writeSkill } from './helpers/fixtures.js';

const root = '.work/js-tests/cli-eval';
afterEach(async () => rm(root, { recursive: true, force: true }));

const cli = (...args) => spawnSync(process.execPath, ['src/cli.js', ...args], { encoding: 'utf8' });

test('help documents the evaluation flags, compare command and JSON schemas', () => {
  const { stdout, status } = cli('--help');
  assert.equal(status, 0);
  for (const pattern of [/--sample <n>/, /--seed <int>/, /--filter <k=v\[,k=v\]>/, /--adaptive/, /--since <run-dir>/, /--probes <file\.jsonl>/, /--fail-under <0\.\.1>/, /Compare options:/, /--fail-on-regression/, /eval compare --base/, /eval compare:\s+\{/, /"gate"\?/, /default: 1; the closed-book baseline/]) assert.match(stdout, pattern);
});

test('rejects invalid evaluation flag values as usage errors', () => {
  for (const args of [['--fail-under', '2'], ['--fail-under', 'high'], ['--sample', '0'], ['--seed', '1.5']]) {
    const result = cli('eval', 'run', '--dataset', 'x', '--skill', 'y', ...args);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /Invalid --/);
  }
  assert.equal(cli('eval', 'compare', '--base', 'a').status, 2);
});

test('eval compare prints a table or stable JSON and gates on regression', async () => {
  const base = path.join(root, 'env');
  const { datasetPath } = await writeDatasetFixture(path.join(base, 'datasets'));
  const skill = await writeSkill(path.join(base, 'skill'));
  const baselineRoot = path.join(base, 'baselines');
  const baseRunner = createFakeRunner();
  await evaluateBaseline({ datasetPath, outputRoot: baselineRoot, workRoot: path.join(base, 'bw'), options: { concurrency: 2 }, subjectRunner: baseRunner, judgeRunner: baseRunner });
  const run = async (name, behavior) => {
    const runner = createFakeRunner({ behavior });
    return evaluateDataset({ datasetPath, skillPath: skill, baselineRoot, outputRoot: path.join(base, name), workRoot: path.join(base, `${name}-work`), options: { trialsPerQuestion: 1, diagnoseFailures: false }, subjectRunner: runner, judgeRunner: runner });
  };
  const good = await run('good', () => ({}));
  const bad = await run('bad', (_, { kind }) => (kind === 'skill' ? { answer: 'wrong' } : {}));

  const json = cli('--json', 'eval', 'compare', '--base', good, '--head', bad, '--dataset', datasetPath);
  assert.equal(json.status, 0);
  const result = JSON.parse(json.stdout);
  assert.equal(result.verdict, 'regressed');
  assert.equal(result.counts.regressed, 5);
  assert.equal(result.regressed.length, 5);

  const gated = cli('--json', 'eval', 'compare', '--base', good, '--head', bad, '--dataset', datasetPath, '--fail-on-regression');
  assert.equal(gated.status, 5);
  assert.equal(JSON.parse(gated.stdout).verdict, 'regressed', 'the result is still printed before the gate exit code');

  const clean = cli('eval', 'compare', '--base', good, '--head', good, '--dataset', datasetPath, '--fail-on-regression');
  assert.equal(clean.status, 0);
  assert.match(clean.stdout, /Verdict +no significant change/);
});
