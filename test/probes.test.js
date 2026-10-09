import assert from 'node:assert/strict';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { buildProbeJudgePrompt, loadProbes, parseProbeJudgment, probeTrialPassed, ProbeError, summarizeProbes } from '../src/probes.js';

const root = '.work/js-tests/probes';
afterEach(async () => rm(root, { recursive: true, force: true }));

async function probesFile(...lines) {
  await mkdir(root, { recursive: true });
  const file = path.join(root, 'probes.jsonl');
  await writeFile(file, lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n'));
  return file;
}

test('loads valid probes and defaults behaviors', async () => {
  const file = await probesFile({ id: 'a', question: ' Q? ', expect: 'refuse', behaviors: ['Cites the chapter'] }, '', { id: 'b', question: 'R?', expect: 'answer' });
  assert.deepEqual(await loadProbes(file), [{ id: 'a', question: 'Q?', expect: 'refuse', behaviors: ['Cites the chapter'] }, { id: 'b', question: 'R?', expect: 'answer', behaviors: [] }]);
});

test('rejects invalid probe files with precise messages', async () => {
  const cases = [
    [['{nope'], /line 1: invalid JSON/],
    [['[]'], /line 1: each probe must be a JSON object/],
    [[{ question: 'Q', expect: 'answer' }], /"id" must be a non-empty string/],
    [[{ id: 'a', question: 'Q', expect: 'answer' }, { id: 'a', question: 'Q', expect: 'answer' }], /line 2: duplicate probe id "a"/],
    [[{ id: 'a', question: '', expect: 'answer' }], /"question" must be a non-empty string/],
    [[{ id: 'a', question: 'Q', expect: 'maybe' }], /"expect" must be "refuse" or "answer"/],
    [[{ id: 'a', question: 'Q', expect: 'answer', behaviors: ['ok', ''] }], /"behaviors" must be an array of non-empty strings/],
    [[], /contains no probes/],
  ];
  for (const [lines, pattern] of cases) await assert.rejects(async () => loadProbes(await probesFile(...lines)), (error) => error instanceof ProbeError && error.code === 'PROBES_INVALID' && error.exitCode === 2 && pattern.test(error.message));
  await assert.rejects(loadProbes(path.join(root, 'missing.jsonl')), /Could not read probes file/);
});

test('builds a judge prompt with the static parts first and the probe input last', () => {
  const prompt = buildProbeJudgePrompt({ probe: { question: 'Q?', expect: 'refuse', behaviors: ['B'] }, answer: 'A', skillFiles: { 'SKILL.md': 'skill text' } });
  assert.ok(prompt.indexOf('SKILL FILES:') < prompt.indexOf('INPUT:'));
  const input = JSON.parse(prompt.split('INPUT:\n')[1]);
  assert.deepEqual(input.expectedBehaviors, ['B']);
  assert.equal(input.candidateAnswer, 'A');
  assert.match(input.expectedOutcome, /decline/);
});

test('validates probe judgments strictly', () => {
  const valid = { refused: true, hallucinated: false, behaviors: [{ index: 1, passed: false, rationale: ' no ' }, { index: 0, passed: true, rationale: 'yes' }], rationale: 'Because.' };
  assert.deepEqual(parseProbeJudgment(JSON.stringify(valid), 2).behaviors, [{ index: 0, passed: true, rationale: 'yes' }, { index: 1, passed: false, rationale: 'no' }]);
  const bad = [
    [{ ...valid, refused: 'yes' }, /refused must be a boolean/],
    [{ ...valid, hallucinated: undefined }, /hallucinated must be a boolean/],
    [{ ...valid, rationale: ' ' }, /rationale must be a non-empty string/],
    [{ ...valid, behaviors: valid.behaviors.slice(1) }, /Expected 2 behavior results, got 1/],
    [{ ...valid, behaviors: [valid.behaviors[0], valid.behaviors[0]] }, /Invalid or duplicate behavior index/],
    [{ ...valid, behaviors: [{ index: 5, passed: true, rationale: 'x' }, valid.behaviors[1]] }, /Invalid or duplicate behavior index: 5/],
    [{ ...valid, behaviors: [{ index: 0, passed: 'y', rationale: 'x' }, valid.behaviors[0]] }, /passed must be a boolean/],
    [{ ...valid, behaviors: [{ index: 0, passed: true, rationale: '' }, valid.behaviors[0]] }, /rationale must not be empty/],
    [{ ...valid, behaviors: 'none' }, /behaviors must be an array/],
  ];
  for (const [value, pattern] of bad) assert.throws(() => parseProbeJudgment(JSON.stringify(value), 2), pattern);
  assert.throws(() => parseProbeJudgment('not json', 0), /not valid JSON/);
});

test('decides whether a probe trial passed', () => {
  const ok = { refused: true, hallucinated: false, behaviors: [{ passed: true }] };
  assert.equal(probeTrialPassed({ expect: 'refuse' }, ok), true);
  assert.equal(probeTrialPassed({ expect: 'answer' }, ok), false);
  assert.equal(probeTrialPassed({ expect: 'refuse' }, { ...ok, hallucinated: true }), false);
  assert.equal(probeTrialPassed({ expect: 'refuse' }, { ...ok, behaviors: [{ passed: false }] }), false);
  assert.equal(probeTrialPassed({ expect: 'answer' }, { refused: false, hallucinated: false, behaviors: [] }), true);
});

test('summarizes probe rates over trials and leaves empty rates null', () => {
  const records = [
    { probeId: 'a', expect: 'refuse', refused: true, hallucinated: false, behaviors: [{ passed: true }, { passed: false }] },
    { probeId: 'a', expect: 'refuse', refused: false, hallucinated: true, behaviors: [{ passed: true }, { passed: true }] },
    { probeId: 'b', expect: 'answer', refused: false, hallucinated: false, behaviors: [] },
    { probeId: 'b', expect: 'answer', refused: true, hallucinated: false, behaviors: [] },
  ];
  assert.deepEqual(summarizeProbes(records), { total: 2, trials: 4, correctRefusalRate: 0.5, hallucinationRate: 0.25, behaviorPassRate: 0.75, answeredWhenExpectedRate: 0.5 });
  assert.deepEqual(summarizeProbes([{ probeId: 'x', expect: 'answer', refused: false, hallucinated: false, behaviors: [] }]), { total: 1, trials: 1, correctRefusalRate: null, hallucinationRate: 0, behaviorPassRate: null, answeredWhenExpectedRate: 1 });
});
