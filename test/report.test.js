import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildReportModel, renderReport } from '../src/report.js';

test('builds an actionable report model from run and dataset records', () => {
  const question = { testId: 'test-1', question: 'How?', questionType: 'procedure', evidenceIds: ['ev-1'], rubric: [{ criterion: 'Explains the procedure.' }] };
  const model = buildReportModel({
    title: 'Example skill',
    manifest: { datasetId: 'ds-1', runId: 'run-1', baselineId: 'baseline-1', createdAt: '2026-09-02T00:00:00Z', evaluatorVersion: '0.5.0', model: 'model', judgeModel: 'judge', trialsPerQuestion: 1 },
    summary: { datasetId: 'ds-1', conditionScores: { closedBook: 0.1, skill: 0.9 }, skillUplift: 0.8, datasetCeiling: 1, diagnosedFailures: 1 },
    dataset: { datasetId: 'ds-1', questions: [question], evidence: [{ evidenceId: 'ev-1', documentId: 'guide.md', quote: 'Do this.' }], documents: { 'guide.md': 'Do this.' } },
    knowledge: [{ knowledgeId: 'ki-1' }],
    answers: [{ testId: 'test-1', trial: 0, condition: 'closedBook', score: 0.1, answer: 'Unknown.' }, { testId: 'test-1', trial: 0, condition: 'skill', score: 0.9, answer: 'Almost complete.' }],
    judgments: [{ testId: 'test-1', trial: 0, condition: 'skill', criterionResults: [{ score: 0.9, rationale: 'Missed one step.' }] }],
    diagnoses: [
      { testId: 'test-1', category: 'skill_knowledge_gap', fixTargets: [{ file: 'SKILL.md', recommendation: 'Add the missing step.' }] },
      { testId: 'test-2', category: 'skill_retrieval', fixTargets: [{ file: 'SKILL.md', recommendation: 'Link the procedure from the main instructions.' }] },
    ],
  });

  assert.deepEqual(model.counts, { documents: 1, knowledge: 1, questions: 1, judgments: 1, fullyCorrect: 0, diagnosedFailures: 1, actionableDiagnoses: 2, targetFiles: 1 });
  assert.deepEqual(model.recommendations, [{
    file: 'SKILL.md',
    changes: [
      { recommendation: 'Add the missing step.', affectedTests: 1 },
      { recommendation: 'Link the procedure from the main instructions.', affectedTests: 1 },
    ],
    category: 'multiple',
    affectedTests: 2,
  }]);
  assert.equal(model.tests[0].source, 'guide.md: “Do this.”');
  assert.equal(model.tests[0].status, 'strong');
  assert.equal(model.tests[0].trials.skill[0].answer, 'Almost complete.');
  assert.deepEqual(model.distribution, { perfect: 0, strong: 1, mixed: 0, weak: 0, zero: 0 });
  assert.equal(model.scores.skill, '90%');
  assert.equal(model.scores.uplift, '+80 pp');
  assert.equal(model.baselineId, 'baseline-1');
  assert.deepEqual(model.scores.skillTrials, ['90%']);
  assert.equal(model.verdict.label, '2 actionable diagnoses across 1 target file');
});

test('rejects a run paired with a different dataset', () => {
  assert.throws(() => buildReportModel({ title: 'Example', manifest: { datasetId: 'wrong' }, summary: { datasetId: 'wrong' }, dataset: { datasetId: 'expected' } }), /does not match/);
});

test('labels variable legacy unknown diagnoses from recorded trials', () => {
  const question = { testId: 'test-1', question: 'How?', questionType: 'fact', evidenceIds: [], rubric: [{ criterion: 'Answers.' }] };
  const model = buildReportModel({
    title: 'Example',
    manifest: { datasetId: 'ds-1' },
    summary: { datasetId: 'ds-1', conditionScores: { closedBook: 0, skill: 0.5 }, skillUplift: 0.5, datasetCeiling: 1, diagnosedFailures: 1 },
    dataset: { datasetId: 'ds-1', questions: [question], evidence: [], documents: {} },
    knowledge: [],
    answers: [
      { testId: 'test-1', trial: 0, condition: 'skill', score: 0, answer: 'No.' },
      { testId: 'test-1', trial: 1, condition: 'skill', score: 1, answer: 'Yes.' },
    ],
    judgments: [],
    diagnoses: [{ testId: 'test-1', category: 'unknown', confidence: 0, fixTargets: [] }],
  });

  assert.equal(model.tests[0].cause, 'answer_variability');
});

test('embeds report data without allowing script injection', () => {
  const html = renderReport('const report = __SKILLFID_REPORT_DATA__;', { title: '</script><script>alert(1)</script>' });
  assert.doesNotMatch(html, /<\/script><script>/);
  assert.match(html, /\\u003c\/script\\u003e/);
});