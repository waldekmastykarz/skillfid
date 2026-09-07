import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import path from 'node:path';

import { assertBaselineCoverage, baselineCompatibilityKey, findCompatibleBaseline, writeBaseline } from '../src/baseline.js';

const root = '.work/js-tests/baseline';
afterEach(async () => rm(root, { recursive: true, force: true }));

test('discovers only an exactly compatible reusable baseline', async () => {
  await mkdir(root, { recursive: true });
  const compatibility = {
    datasetId: 'ds_one', evaluatorVersion: '1', copilotCliVersion: 'cli',
    model: 'subject-a', judgeModel: 'judge', reasoningEffort: 'medium', trialsPerQuestion: 1,
  };
  const answers = [{ testId: 'q1', trial: 0, condition: 'closedBook', answer: 'unknown', score: 0 }];
  const judgments = [{ testId: 'q1', trial: 0, condition: 'closedBook', criterionResults: [], unsupportedClaims: [], score: 0 }];
  const baselinePath = await writeBaseline({ outputRoot: root, compatibility, answers, judgments });

  assert.equal(baselineCompatibilityKey(compatibility), baselineCompatibilityKey({ ...compatibility }));
  assert.equal((await findCompatibleBaseline({ outputRoot: root, compatibility })).baselinePath, path.resolve(baselinePath));
  assert.equal(await findCompatibleBaseline({ outputRoot: root, compatibility: { ...compatibility, model: 'subject-b' } }), undefined);
});

test('rejects baseline coverage that omits a requested trial', () => {
  const baseline = {
    answers: [{ testId: 'q1', trial: 0, condition: 'closedBook', answer: 'unknown', score: 0 }],
    judgments: [{ testId: 'q1', trial: 0, condition: 'closedBook', criterionResults: [], unsupportedClaims: [], score: 0 }],
  };
  assert.throws(() => assertBaselineCoverage(baseline, [{ testId: 'q1' }], 2), /coverage does not match/);
});