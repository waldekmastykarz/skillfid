import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { evaluateBaseline, evaluateDataset } from '../src/evaluation.js';
import { buildReportModel, generateEvaluationReport, renderReport } from '../src/report.js';
import { createFakeRunner, writeDatasetFixture, writeSkill } from './helpers/fixtures.js';

const root = '.work/js-tests/report';
afterEach(async () => rm(root, { recursive: true, force: true }));

const dataset = (overrides = {}) => ({
  datasetId: 'ds-1',
  questions: [{ testId: 'test-1', question: 'How?', questionType: 'procedure', difficulty: 'hard', evidenceIds: ['ev-1'], rubric: [{ criterion: 'Explains the procedure.', knowledgeItemIds: ['ki-1'] }] }],
  evidence: [{ evidenceId: 'ev-1', documentId: 'guide.md', sectionId: 'sec_aaaa1111', start: 12, quote: 'Do this.' }],
  documents: { 'guide.md': '# Guide\n\n## Steps\n\nDo this.' },
  ...overrides,
});
const manifest = { datasetId: 'ds-1', runId: 'run-1', baselineId: 'baseline-1', createdAt: '2026-09-02T00:00:00Z', evaluatorVersion: '0.9.0', model: 'model', judgeModel: 'judge', trialsPerQuestion: 1 };

test('builds an actionable report model from run and dataset records', () => {
  const model = buildReportModel({
    title: 'Example skill',
    manifest,
    summary: { datasetId: 'ds-1', conditionScores: { closedBook: 0.1, skill: 0.9 }, skillUplift: 0.8, datasetCeiling: 1, diagnosedFailures: 1 },
    dataset: dataset(),
    knowledge: [{ knowledgeId: 'ki-1', importance: 'high', sectionId: 'sec_aaaa1111' }],
    answers: [{ testId: 'test-1', trial: 0, condition: 'closedBook', score: 0.1, answer: 'Unknown.' }, { testId: 'test-1', trial: 0, condition: 'skill', score: 0.9, answer: 'Almost complete.' }],
    judgments: [{ testId: 'test-1', trial: 0, condition: 'skill', criterionResults: [{ score: 0.9, rationale: 'Missed one step.' }] }],
    diagnoses: [
      { testId: 'test-1', category: 'skill_knowledge_gap', fixTargets: [{ file: 'SKILL.md', recommendation: 'Add the missing step.' }] },
      { testId: 'test-2', category: 'skill_retrieval', fixTargets: [{ file: 'SKILL.md', recommendation: 'Link the procedure from the main instructions.' }] },
    ],
  });

  assert.deepEqual(model.counts, { documents: 1, knowledge: 1, questions: 1, judgments: 1, fullyCorrect: 0, diagnosedFailures: 1, actionableDiagnoses: 2, targetFiles: 1 });
  assert.equal(model.recommendations.length, 1);
  assert.equal(model.recommendations[0].file, 'SKILL.md');
  assert.equal(model.recommendations[0].affectedTests, 2);
  assert.equal(model.recommendations[0].category, 'multiple');
  assert.deepEqual(model.recommendations[0].changes.map((change) => [change.recommendation, change.affectedTests]), [['Add the missing step.', 1], ['Link the procedure from the main instructions.', 1]]);
  // Only test-1 exists in the run: shortfall 0.1 over one question = 10 points.
  assert.ok(Math.abs(model.recommendations[0].potentialPoints - 10) < 1e-9);
  assert.equal(model.recommendations[0].impact, 'affects 2 questions, potential +10.0 pts');
  assert.equal(model.tests[0].source, 'guide.md: “Do this.”');
  assert.equal(model.tests[0].status, 'strong');
  assert.equal(model.tests[0].importance, 'high');
  assert.equal(model.tests[0].trials.skill[0].answer, 'Almost complete.');
  assert.deepEqual(model.distribution, { perfect: 0, strong: 1, mixed: 0, weak: 0, zero: 0 });
  assert.equal(model.scores.skill, '90%');
  assert.equal(model.scores.uplift, '+80 pp');
  assert.equal(model.scores.skillInterval, undefined, 'a single question has no interval');
  assert.equal(model.baselineId, 'baseline-1');
  assert.deepEqual(model.scores.skillTrials, ['90%']);
  assert.equal(model.verdict.label, '2 actionable diagnoses across 1 target file');
  assert.equal(model.partial, undefined);
  assert.equal(model.probes, undefined);
});

test('ranks fix targets by expected impact and reports confidence intervals', () => {
  const questions = ['a', 'b', 'c', 'd'].map((id) => ({ testId: id, question: `Question ${id}`, questionType: id < 'c' ? 'fact' : 'procedure', difficulty: 'easy', evidenceIds: [], rubric: [{ criterion: 'X.' }] }));
  const skill = { a: 0, b: 0.5, c: 1, d: 0.9 };
  const answers = questions.flatMap((question) => [{ testId: question.testId, trial: 0, condition: 'closedBook', score: 0, answer: '' }, { testId: question.testId, trial: 0, condition: 'skill', score: skill[question.testId], answer: '' }]);
  const model = buildReportModel({
    title: 'Ranked', manifest, summary: { datasetId: 'ds-1', conditionScores: { closedBook: 0, skill: 0.6 }, skillUplift: 0.6, diagnosedFailures: 3 },
    dataset: dataset({ questions, evidence: [] }), knowledge: [], answers, judgments: [],
    diagnoses: [
      { testId: 'd', category: 'skill_retrieval', fixTargets: [{ file: 'small.md', recommendation: 'Link it.' }] },
      { testId: 'a', category: 'skill_knowledge_gap', fixTargets: [{ file: 'big.md', recommendation: 'Add it.' }] },
      { testId: 'b', category: 'skill_knowledge_gap', fixTargets: [{ file: 'big.md', recommendation: 'Add it.' }] },
    ],
  });
  assert.deepEqual(model.recommendations.map((item) => item.file), ['big.md', 'small.md']);
  assert.equal(model.recommendations[0].expectedImpact, 1.5);
  assert.equal(model.recommendations[0].impact, 'affects 2 questions, potential +37.5 pts');
  assert.equal(model.recommendations[1].impact, 'affects 1 question, potential +2.5 pts');
  // skill means 0, .5, 1, .9 give mean .6 and t(3) = 3.182
  const half = 3.182 * Math.sqrt((0.6 ** 2 + 0.1 ** 2 + 0.4 ** 2 + 0.3 ** 2) / 3) / 2;
  const clamp = (value) => Math.max(0, Math.min(1, value));
  assert.equal(model.scores.skillInterval, `${(clamp(0.6 - half) * 100).toFixed(1)}%–${(clamp(0.6 + half) * 100).toFixed(1)}%`);
  assert.match(model.scores.upliftInterval, / to \+\d+\.\d pp$/);
  assert.match(model.verdict.detail, /95% CI/);
  assert.deepEqual(model.breakdowns.type.map((row) => [row.key, row.n, row.skill]), [['fact', 2, '25%'], ['procedure', 2, '95%']]);
  assert.deepEqual(model.breakdowns.difficulty.map((row) => row.key), ['easy']);
  assert.equal(model.breakdowns.importance[0].key, 'unmapped');
});

test('builds breakdowns, a section heat map, failure stages, behavior and usage from run records', () => {
  const extra = { testId: 'test-2', question: 'Why?', questionType: 'fact', difficulty: 'easy', evidenceIds: ['ev-2'], rubric: [{ criterion: 'Gives the reason.', knowledgeItemIds: ['ki-2'] }] };
  const data = dataset({
    questions: [...dataset().questions, extra],
    evidence: [...dataset().evidence, { evidenceId: 'ev-2', documentId: 'guide.md', sectionId: 'sec_bbbb2222', start: 40, quote: 'Because.' }],
    documents: { 'guide.md': '# Guide\n\n## Steps\n\nDo this.\n\n## Reasons\n\nBecause it is so.' },
  });
  const trace = { skillLoaded: true, filesRead: [{ path: '.github/skills/s/SKILL.md', bytes: 10 }], toolCalls: [], turns: 2, inputTokens: 1000, outputTokens: 50 };
  const model = buildReportModel({
    title: 'Behavior', manifest: { ...manifest, partial: true, subset: { questions: 2, of: 7, sample: { n: 2, seed: 3 } }, adaptive: true, incremental: { since: 'run-0', rerun: 1, carried: 1, changedFiles: { changed: ['SKILL.md'], added: [], removed: [] } } },
    summary: { datasetId: 'ds-1', partial: true, subset: { questions: 2, of: 7, sample: { n: 2, seed: 3 } }, conditionScores: { closedBook: 0, skill: 0.5 }, skillUplift: 0.5, diagnosedFailures: 1,
      probes: { total: 1, correctRefusalRate: 1, hallucinationRate: 0, behaviorPassRate: 0.5, answeredWhenExpectedRate: null } },
    dataset: data, knowledge: [{ knowledgeId: 'ki-1', importance: 'low', sectionId: 'sec_aaaa1111' }, { knowledgeId: 'ki-2', importance: 'high', sectionId: 'sec_bbbb2222' }, { knowledgeId: 'ki-3', importance: 'high', sectionId: 'sec_cccc3333' }],
    answers: [
      { testId: 'test-1', trial: 0, condition: 'closedBook', score: 0, answer: 'x', durationSeconds: 1 },
      { testId: 'test-1', trial: 0, condition: 'skill', score: 0, answer: 'x', durationSeconds: 2, trace, stage: 'retrieval_miss', disclosure: { skillLoaded: true, filesRead: 1, bytesRead: 10, fractionOfSkillLoaded: 0.5, loadedEverything: false } },
      { testId: 'test-2', trial: 0, condition: 'closedBook', score: 0, answer: 'x', durationSeconds: 3 },
      { testId: 'test-2', trial: 0, condition: 'skill', score: 1, answer: 'y', durationSeconds: 4, trace, disclosure: { skillLoaded: true, filesRead: 3, bytesRead: 30, fractionOfSkillLoaded: 1, loadedEverything: true }, carriedFrom: 'run-0' },
    ],
    judgments: [], diagnoses: [],
    probes: [{ probeId: 'p1', trial: 0, question: 'Out of scope?', expect: 'refuse', expectedBehaviors: ['Cites chapter'], answer: 'No.', refused: true, hallucinated: false, behaviors: [{ index: 0, passed: false, rationale: 'No citation.' }], rationale: 'Declined.', passed: false }],
  });

  assert.deepEqual(model.partial, { questions: 2, of: 7, sample: { n: 2, seed: 3 }, filter: undefined });
  assert.equal(model.incremental.carried, 1);
  assert.equal(model.adaptive, true);
  assert.deepEqual(model.breakdowns.type.map((row) => [row.key, row.n]), [['fact', 1], ['procedure', 1]]);
  assert.deepEqual(model.breakdowns.importance.map((row) => row.key), ['high', 'low']);
  assert.deepEqual(model.breakdowns.section.map((row) => [row.label, row.skill]), [['Steps', '0%'], ['Reasons', '100%']]);
  assert.deepEqual(model.breakdowns.document.map((row) => [row.label, row.n, row.baseline, row.skill, row.uplift]), [['guide.md', 2, '0%', '50%', '+50 pp']]);
  assert.equal(model.heatmap.length, 1);
  assert.deepEqual(model.heatmap[0].sections.map((cell) => [cell.label, cell.skill, cell.n]), [['Steps', 0, 1], ['Reasons', 1, 1]]);
  assert.match(model.heatmap[0].sections[1].title, /guide\.md › Reasons: 100% across 1 question/);
  assert.equal(model.failureStages.failingTrials, 1);
  assert.deepEqual(model.failureStages.rows.find((row) => row.stage === 'retrieval_miss'), { stage: 'retrieval_miss', label: 'Retrieval miss', count: 1, share: 1 });
  assert.equal(model.tests[0].stage, 'retrieval_miss');
  assert.equal(model.tests[1].carried, true);
  assert.deepEqual(model.progressiveDisclosure, { skillLoadedRate: '100%', meanFilesRead: '2.0', meanBytesRead: '20 B', meanFractionLoaded: '75%', loadedEverythingRate: '50%' });
  assert.deepEqual(model.usage.skill, { trials: 2, medianSeconds: '3.0 s', p90Seconds: '3.8 s', meanInputTokens: '1,000', meanOutputTokens: '50', meanTurns: '2.0' });
  assert.equal(model.probes.summary.correctRefusalRate, '100%');
  assert.equal(model.probes.summary.answeredWhenExpectedRate, '--');
  assert.deepEqual(model.probes.rows[0].details[0].behaviors, [{ text: 'Cites chapter', passed: false, rationale: 'No citation.' }]);
  assert.equal(model.counts.questions, 2);
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
  assert.equal(model.progressiveDisclosure, undefined);
  assert.equal(model.usage.skill, undefined);
});

test('embeds report data without allowing script injection', () => {
  const html = renderReport('const report = __SKILLFID_REPORT_DATA__;', { title: '</script><script>alert(1)</script>' });
  assert.doesNotMatch(html, /<\/script><script>/);
  assert.match(html, /\\u003c\/script\\u003e/);
});

test('generates a single-file report from a real evaluation, including probes, and its script parses', async () => {
  const base = path.join(root, 'full');
  const { datasetPath } = await writeDatasetFixture(path.join(base, 'datasets'));
  const skill = await writeSkill(path.join(base, 'skill'));
  const runner = createFakeRunner({ behavior: (question, { kind }) => (kind === 'skill' && question === 'How long is data kept?' ? { answer: 'wrong' } : {}) });
  await evaluateBaseline({ datasetPath, outputRoot: path.join(base, 'baselines'), workRoot: path.join(base, 'bw'), options: { concurrency: 2 }, subjectRunner: runner, judgeRunner: runner });
  const probesPath = path.join(base, 'probes.jsonl');
  await writeFile(probesPath, `${JSON.stringify({ id: 'p1', question: 'Unrelated?', expect: 'refuse', behaviors: ['CITED'] })}\n`);
  const runPath = await evaluateDataset({ datasetPath, skillPath: skill, baselineRoot: path.join(base, 'baselines'), outputRoot: path.join(base, 'runs'), workRoot: path.join(base, 'work'), options: { concurrency: 3, trialsPerQuestion: 2, sample: 4, seed: 2, probesPath }, subjectRunner: runner, judgeRunner: runner });

  const reportPath = await generateEvaluationReport({ runPath, datasetPath, title: 'Fixture skill' });
  const html = await readFile(reportPath, 'utf8');

  assert.doesNotMatch(html, /__SKILLFID_REPORT_DATA__/);
  assert.match(html, /const report = \{"title":"Fixture skill"/);
  assert.match(html, /"partial":\{"questions":4,"of":5/);
  assert.match(html, /"probes":\{"summary"/);
  assert.match(html, /id="test-table"/);
  const script = html.split('<script>').at(-1).split('</script>')[0];
  assert.doesNotThrow(() => new Function(script));
});
