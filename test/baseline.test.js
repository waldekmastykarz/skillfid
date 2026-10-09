import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import path from 'node:path';

import { assertBaselineCoverage, baselineCompatibilityKey, BaselineError, findCompatibleBaseline, writeBaseline } from '../src/baseline.js';

const root = '.work/js-tests/baseline';
afterEach(async () => rm(root, { recursive: true, force: true }));

const record = (testId, trial) => ({ testId, trial, condition: 'closedBook', answer: 'unknown', score: 0 });
const judgment = (testId, trial) => ({ testId, trial, condition: 'closedBook', criterionResults: [], unsupportedClaims: [], score: 0 });

test('discovers only an exactly compatible reusable baseline', async () => {
  await mkdir(root, { recursive: true });
  const compatibility = { datasetId: 'ds_one', evaluatorVersion: '1', copilotCliVersion: 'cli', model: 'subject-a', judgeModel: 'judge', reasoningEffort: 'medium' };
  const baselinePath = await writeBaseline({ outputRoot: root, compatibility, answers: [record('q1', 0)], judgments: [judgment('q1', 0)] });

  assert.equal(baselineCompatibilityKey(compatibility), baselineCompatibilityKey({ ...compatibility }));
  assert.equal((await findCompatibleBaseline({ outputRoot: root, compatibility })).baselinePath, path.resolve(baselinePath));
  assert.equal(await findCompatibleBaseline({ outputRoot: root, compatibility: { ...compatibility, model: 'subject-b' } }), undefined);
  assert.equal(await findCompatibleBaseline({ outputRoot: root, compatibility: { ...compatibility, judgeModel: 'other' } }), undefined);
  assert.equal(await findCompatibleBaseline({ outputRoot: root, compatibility: { ...compatibility, copilotCliVersion: 'newer' } }), undefined);
});

test('a baseline covers any question subset and any skill trial count that needs at most its trials', () => {
  const baseline = { answers: [record('q1', 0), record('q2', 0), record('q2', 1)], judgments: [judgment('q1', 0), judgment('q2', 0), judgment('q2', 1)] };
  assert.doesNotThrow(() => assertBaselineCoverage(baseline, [{ testId: 'q1' }, { testId: 'q2' }]));
  assert.doesNotThrow(() => assertBaselineCoverage(baseline, [{ testId: 'q2' }], 2));
  assert.doesNotThrow(() => assertBaselineCoverage(baseline, [{ testId: 'q1' }]));
});

test('rejects baseline coverage that omits a requested question or required trials', () => {
  const baseline = { answers: [record('q1', 0)], judgments: [judgment('q1', 0)] };
  assert.throws(() => assertBaselineCoverage(baseline, [{ testId: 'q1' }, { testId: 'q2' }]), (error) => error instanceof BaselineError && /does not include 1 of 2 questions/.test(error.message) && error.details.missingTestIds[0] === 'q2');
  assert.throws(() => assertBaselineCoverage(baseline, [{ testId: 'q1' }], 2), /at least 2 trials each/);
});

test('rejects baselines whose answers and judgments do not match', () => {
  assert.throws(() => assertBaselineCoverage({ answers: [record('q1', 0)], judgments: [] }, [{ testId: 'q1' }]), /judgments must match/);
});
