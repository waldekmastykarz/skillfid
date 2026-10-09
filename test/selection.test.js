import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildSectionIndex, filterQuestions, parseFilter, questionImportance, sampleQuestions, selectQuestions } from '../src/selection.js';

const types = { fact: 10, procedure: 5, synthesis: 5 };
const questions = Object.entries(types).flatMap(([type, count]) => Array.from({ length: count }, (_, index) => ({ testId: `${type}-${index}`, questionType: type, difficulty: index % 2 ? 'hard' : 'easy', evidenceIds: [`ev-${type}-${index}`], rubric: [{ knowledgeItemIds: [`ki-${index % 3}`] }] })));

test('samples deterministically and proportionally with at least one question per type', () => {
  const first = sampleQuestions(questions, 10, 42);
  const again = sampleQuestions([...questions].reverse(), 10, 42);
  assert.deepEqual(first.map((item) => item.testId).sort(), again.map((item) => item.testId).sort());
  assert.equal(first.length, 10);
  const counts = Object.fromEntries(Object.keys(types).map((type) => [type, first.filter((item) => item.questionType === type).length]));
  assert.deepEqual(counts, { fact: 5, procedure: 3, synthesis: 2 });
  assert.notDeepEqual(sampleQuestions(questions, 10, 43).map((item) => item.testId), first.map((item) => item.testId));
  assert.deepEqual(first.map((item) => item.testId), questions.filter((item) => first.includes(item)).map((item) => item.testId), 'dataset order is preserved');
});

test('covers every type when the sample allows and handles small and oversized samples', () => {
  const three = sampleQuestions(questions, 3, 1);
  assert.deepEqual(new Set(three.map((item) => item.questionType)), new Set(Object.keys(types)));
  assert.equal(sampleQuestions(questions, 1, 1).length, 1);
  assert.equal(sampleQuestions(questions, 2, 1).length, 2);
  assert.equal(sampleQuestions(questions, 100, 1), questions);
  assert.throws(() => sampleQuestions(questions, 0), /positive integer/);
});

test('parses and validates filter expressions', () => {
  assert.deepEqual(parseFilter('type=fact, difficulty=hard'), [{ key: 'type', value: 'fact' }, { key: 'difficulty', value: 'hard' }]);
  assert.deepEqual(parseFilter(undefined), []);
  assert.throws(() => parseFilter('type'), /Expected key=value/);
  assert.throws(() => parseFilter('colour=red'), /Unknown --filter key/);
  assert.throws(() => parseFilter('importance=urgent'), /Invalid importance/);
});

const evidence = [
  { evidenceId: 'ev-fact-0', documentId: 'docs/guide.md', sectionId: 'sec_abc123', start: 30 },
  { evidenceId: 'ev-fact-1', documentId: 'docs/other.md', sectionId: 'sec_def456', start: 5 },
];
const documents = { 'docs/guide.md': '# Guide\n\n## Retention rules\n\nText about retention here.', 'docs/other.md': '# Other\n\nBody' };
const knowledge = [{ knowledgeId: 'ki-0', importance: 'low' }, { knowledgeId: 'ki-1', importance: 'high' }, { knowledgeId: 'ki-2', importance: 'medium' }];

test('filters by type, difficulty, importance, document and section', () => {
  const apply = (filter) => filterQuestions({ questions, terms: parseFilter(filter), knowledge, evidence, documents }).map((item) => item.testId);
  assert.equal(apply('type=procedure').length, 5);
  assert.equal(apply('type=procedure,difficulty=hard').length, 2);
  assert.equal(apply('type=fact,type=synthesis').length, 15);
  assert.equal(apply('importance=high').length, 7);
  assert.deepEqual(apply('document=guide.md'), ['fact-0']);
  assert.deepEqual(apply('document=docs/other.md'), ['fact-1']);
  assert.deepEqual(apply('section=sec_abc'), ['fact-0']);
  assert.deepEqual(apply('section=retention RULES'), ['fact-0']);
  assert.deepEqual(apply('section=nothing'), []);
  assert.equal(questionImportance({ rubric: [{ knowledgeItemIds: ['ki-0', 'ki-2'] }] }, new Map(knowledge.map((item) => [item.knowledgeId, item]))), 'medium');
});

test('derives section labels from the nearest preceding heading', () => {
  const index = buildSectionIndex({ evidence, documents });
  assert.equal(index.get('sec_abc123').heading, 'Retention rules');
  assert.equal(index.get('sec_def456').label, 'Other');
  assert.equal(buildSectionIndex({ evidence: [{ evidenceId: 'x', documentId: 'none', sectionId: 'sec_12345678abc', start: 0 }], documents: {} }).get('sec_12345678abc').label, '12345678');
});

test('selects the filtered set, then samples, and reports partial runs', () => {
  const all = selectQuestions({ questions, knowledge, evidence, documents });
  assert.equal(all.partial, false);
  const subset = selectQuestions({ questions, knowledge, evidence, documents, filter: 'type=fact', sample: 4, seed: 9 });
  assert.equal(subset.questions.length, 4);
  assert.ok(subset.questions.every((item) => item.questionType === 'fact'));
  assert.deepEqual(subset.sample, { n: 4, seed: 9 });
  assert.equal(subset.partial, true);
  assert.throws(() => selectQuestions({ questions, knowledge, evidence, documents, filter: 'type=nothing' }), /matched no questions/);
});
