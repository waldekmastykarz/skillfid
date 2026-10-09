import assert from 'node:assert/strict';
import { test } from 'node:test';

import { oraclePrompt } from '../src/prompts.js';

test('oracle prompt prioritizes complete source fidelity over brevity', () => {
  const prompt = oraclePrompt('Compare both measured outcomes.', ['The first test was 4/5. The second test was 5/5.']);

  assert.match(prompt, /Answer every part/);
  assert.match(prompt, /Preserve numbers, counts, qualifiers, causal claims, and scope exactly/);
  assert.match(prompt, /distinguish those contexts explicitly/);
  assert.doesNotMatch(prompt, /concise final answer/);
});

test('recalibration oracle prompt uses rubric as coverage guidance without displacing the source', () => {
  const prompt = oraclePrompt('What happened?', ['The source answer.'], [{ criterion: 'States the source answer.', weight: 1 }]);

  assert.match(prompt, /Calibration coverage requirements:/);
  assert.match(prompt, /minimum coverage, not an exhaustive answer boundary/);
  assert.match(prompt, /scan the complete source independently of the requirements/);
  assert.match(prompt, /all applicable prerequisites, exceptions, and repeated measurements/);
  assert.match(prompt, /answer the user's question fully/);
  assert.match(prompt, /If a requirement conflicts with the source, the source wins/);
  assert.match(prompt, /never repeat the requirement unqualified/);
  assert.match(prompt, /Omit unrelated background, examples, and adjacent source facts/);
  assert.ok(prompt.indexOf('Use only this complete source:') < prompt.indexOf('Calibration coverage requirements:'));
  assert.ok(prompt.indexOf('Use only this complete source:') < prompt.indexOf('User question:'));
});