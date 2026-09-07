import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseInventoryResponse } from '../src/inventory.js';
import { buildQuestionPrompt, parseQuestionResponse } from '../src/questions.js';
import { parseVerificationResponse } from '../src/verification.js';
import { parseJudgeResponse } from '../src/judge.js';
import { parseSkillAudit } from '../src/diagnosis.js';

const document = { documentId: 'policy.md', revision: 'rev', content: '# Limits\n\nUploads larger than two gigabytes are rejected.\n' };
const section = { sectionId: 'sec_1', documentId: 'policy.md', heading: 'Limits', content: document.content.trim(), start: 0, end: document.content.length };

test('parses inventory with exact provenance', () => {
  const result = parseInventoryResponse(JSON.stringify({ classification: 'informational', reason: 'A limit.', items: [{ kind: 'constraint', statement: 'Uploads cannot exceed two gigabytes.', importance: 'high', importanceReason: 'Enforced limit.', quote: 'Uploads larger than two gigabytes are rejected.' }] }), { section, document });
  assert.equal(document.content.slice(result.evidence[0].start, result.evidence[0].end), result.evidence[0].quote);
  assert.match(result.items[0].knowledgeId, /^ki_/);
});

test('question parsing requires complete, narrowly scoped coverage', () => {
  const evidence = [{ evidenceId: 'ev_1', quote: 'Limit is two.' }];
  const items = [{ knowledgeId: 'ki_1', kind: 'constraint', statement: 'Limit is two.', importance: 'high', evidenceIds: ['ev_1'] }];
  const response = JSON.stringify({ questions: [{ question: 'What is the limit?', type: 'fact', difficulty: 'easy', rubric: [{ criterion: 'States two.', weight: 1, knowledgeItemIds: ['ki_1'] }] }] });
  assert.deepEqual(parseQuestionResponse(response, items)[0].evidenceIds, ['ev_1']);
  assert.match(buildQuestionPrompt(items, evidence), /one coherent operational concern/);
  assert.match(buildQuestionPrompt(items, evidence), /Prefer one complete question over atomizing/);
  assert.match(buildQuestionPrompt(items, evidence), /may appear in more than one question/);
  assert.throws(() => parseQuestionResponse(response.replace('"weight":1', '"weight":0.5'), items), /sum to 1/);
});

test('verification passes only when every gate passes', () => {
  const result = parseVerificationResponse(JSON.stringify({ answerable: true, referenceSupported: true, criteriaSupported: true, mappedItemsRequired: true, requiresCorpusKnowledge: true, unambiguous: true, answerLeakage: false, reason: 'Supported.' }));
  assert.equal(result.passed, true);
});

test('judge validates and sorts criterion results', () => {
  const result = parseJudgeResponse(JSON.stringify({ criterionResults: [{ criterionIndex: 1, score: 0.5, rationale: 'Partial' }, { criterionIndex: 0, score: 1, rationale: 'Correct' }], unsupportedClaims: [] }), 2);
  assert.deepEqual(result.criterionResults.map((item) => item.criterionIndex), [0, 1]);
  assert.throws(() => parseJudgeResponse('```json\n{}\n```', 1), /not valid JSON/);
});

test('skill audit validates booleans and normalizes files', () => {
  const result = parseSkillAudit(JSON.stringify({ present: true, complete: true, contradictory: false, files: ['SKILL.md', 'SKILL.md'], rationale: 'Present.' }));
  assert.deepEqual(result.files, ['SKILL.md']);
});