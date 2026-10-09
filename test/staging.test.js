import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyFailure, containsEvidence, dominantStage, filesContainingEvidence, isRefusal, normalizeText, summarizeStages } from '../src/staging.js';

const QUOTE = 'Keys rotate every ninety days.';
const skillFiles = [
  { path: 'SKILL.md', content: '# Skill\nSee references.' },
  { path: 'references/security.md', content: 'Security\n\nkeys   ROTATE every ninety days.\nOther text.' },
];
const trace = (...paths) => ({ skillLoaded: true, filesRead: paths.map((file) => ({ path: `.github/skills/s/${file}`, bytes: 1 })) });

test('normalizes whitespace, case and typographic quotes', () => {
  assert.equal(normalizeText('  It’s   “Fine”\n'), 'it\'s "fine"');
});

test('matches evidence exactly after normalization or by word-shingle overlap', () => {
  assert.equal(containsEvidence('Intro. keys   ROTATE every ninety days. End', QUOTE), true);
  assert.equal(containsEvidence('Rotation of keys happens quarterly.', QUOTE), false);
  const long = 'The service retains cached artifacts for fourteen days after the last access and then evicts them automatically';
  assert.equal(containsEvidence('The service retains cached artifacts for fourteen days after the last access and then removes them automatically', long), true);
  assert.equal(containsEvidence('The service retains cached artifacts for a few weeks and evicts them', long), false);
  assert.equal(containsEvidence('anything', ''), false);
  assert.deepEqual(filesContainingEvidence(skillFiles, [QUOTE]), ['references/security.md']);
  assert.deepEqual(filesContainingEvidence([{ path: 'x.png' }], [QUOTE]), []);
});

test('recognizes refusal-style answers', () => {
  for (const answer of ["I don't know.", 'That is not covered in the skill.', 'The skill does not specify a rotation period.', 'I couldn’t find this.', 'Unknown', 'There is no information about it.']) assert.equal(isRefusal(answer), true, answer);
  for (const answer of ['Keys rotate every 90 days.', 'Rotate quarterly.']) assert.equal(isRefusal(answer), false, answer);
});

const cases = [
  ['perfect trials are not staged', { score: 1, trace: trace('SKILL.md') }, undefined],
  ['skill never loaded', { score: 0, trace: { skillLoaded: false, filesRead: [] }, answer: 'x' }, 'not_discovered'],
  ['loaded but evidence file unread', { score: 0, trace: trace('SKILL.md'), answer: 'Quarterly.' }, 'retrieval_miss'],
  ['refusal although the evidence was read', { score: 0, trace: trace('SKILL.md', 'references/security.md'), answer: "I don't know." }, 'false_refusal'],
  ['refusal although the skill has the evidence but it was not read', { score: 0, trace: trace('SKILL.md'), answer: 'This is not covered.' }, 'false_refusal'],
  ['unsupported claims after reading the evidence', { score: 0.5, trace: trace('references/security.md'), answer: 'Every year.', unsupportedClaims: ['Yearly rotation.'] }, 'hallucination'],
  ['evidence read, answer wrong', { score: 0.5, trace: trace('references/security.md'), answer: 'Every sixty days.' }, 'application_error'],
  ['no trace and no claims', { score: 0, answer: 'Maybe.' }, 'unknown'],
  ['no trace but unsupported claims is still unknown without a read check', { score: 0, answer: 'Maybe.', unsupportedClaims: ['Invented.'] }, 'hallucination'],
  ['no evidence quotes to check', { score: 0, trace: trace('SKILL.md'), evidenceQuotes: [], answer: 'Maybe.' }, 'unknown'],
];
for (const [name, input, expected] of cases) {
  test(`classifies: ${name}`, () => {
    const result = classifyFailure({ skillFiles, evidenceQuotes: [QUOTE], ...input });
    assert.equal(result?.stage, expected);
  });
}

test('records where the evidence is in the stage detail', () => {
  const { detail } = classifyFailure({ score: 0, trace: trace('SKILL.md'), skillFiles, evidenceQuotes: [QUOTE], answer: 'Quarterly.' });
  assert.deepEqual(detail, { evidenceInSkill: true, evidenceRead: false });
});

test('summarizes stages and picks the dominant one', () => {
  const answers = [{ stage: 'retrieval_miss' }, { stage: 'retrieval_miss' }, { stage: 'hallucination' }, {}];
  assert.deepEqual(summarizeStages(answers), { not_discovered: 0, retrieval_miss: 2, false_refusal: 0, hallucination: 1, application_error: 0, unknown: 0 });
  assert.equal(dominantStage(answers), 'retrieval_miss');
  assert.equal(dominantStage([{ stage: 'hallucination' }, { stage: 'not_discovered' }]), 'not_discovered');
  assert.equal(dominantStage([{}]), undefined);
});
