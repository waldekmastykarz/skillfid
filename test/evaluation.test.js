import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import path from 'node:path';

import { buildDataset } from '../src/dataset.js';
import { evaluateBaseline, evaluateDataset, formatScore, summarizeCriterionFailures } from '../src/evaluation.js';
import { OperationJournal } from '../src/journal.js';
import { generateEvaluationReport } from '../src/report.js';

const root = '.work/js-tests/evaluation';
afterEach(async () => rm(root, { recursive: true, force: true }));

test('formats final scores without hiding near-perfect results', () => {
  assert.equal(formatScore(0), '0%');
  assert.equal(formatScore(0.9989473684210527), '99.895%');
  assert.equal(formatScore(0.999999), '99.9999%');
  assert.equal(formatScore(1), '100%');
});

test('summarizes criterion failures across every trial', () => {
  const failures = summarizeCriterionFailures([{}, {}], [
    { criterionResults: [{ criterionIndex: 0, score: 0, rationale: 'Missing.' }, { criterionIndex: 1, score: 1, rationale: 'Complete.' }] },
    { criterionResults: [{ criterionIndex: 0, score: 1, rationale: 'Complete.' }, { criterionIndex: 1, score: 0.5, rationale: 'Partial.' }] },
    { criterionResults: [{ criterionIndex: 0, score: 0.5, rationale: 'Incomplete.' }, { criterionIndex: 1, score: 1, rationale: 'Complete.' }] },
  ]);

  assert.deepEqual(failures, [
    { criterionIndex: 0, averageScore: 0.5, failedTrials: 2, totalTrials: 3, rationales: ['Missing.', 'Incomplete.'] },
    { criterionIndex: 1, averageScore: 5 / 6, failedTrials: 1, totalTrials: 3, rationales: ['Partial.'] },
  ]);
});

test('reuses a separate closed-book baseline for skill evaluation', async () => {
  const corpus = path.join(root, 'corpus');
  const skill = path.join(root, 'skill');
  await mkdir(corpus, { recursive: true });
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(corpus, 'policy.md'), '# Limit\n\nThe limit is two gigabytes.\n');
  await writeFile(path.join(skill, 'SKILL.md'), '# Test skill\n\nThe limit is two gigabytes.\n');
  const inventory = JSON.stringify({ classification: 'informational', reason: 'A fact.', items: [{ kind: 'fact', statement: 'The limit is two gigabytes.', importance: 'high', importanceReason: 'Limit.', quote: 'The limit is two gigabytes.' }] });
  const noMissing = JSON.stringify({ classification: 'non_informational', reason: 'Complete.', items: [] });
  const verification = JSON.stringify({ answerable: true, referenceSupported: true, criteriaSupported: true, mappedItemsRequired: true, requiresCorpusKnowledge: true, unambiguous: true, answerLeakage: false, reason: 'Valid.' });
  const extractionResponses = [inventory, noMissing, noMissing, verification];
  const extractionRunner = { async run(_workspace, prompt) { if (prompt.includes('Calibrate this question')) return { answer: JSON.stringify({ criterionResults: [{ criterionIndex: 0, score: 1, rationale: 'Complete.' }], unsupportedClaims: [], verification: { answerable: true, referenceSupported: true, criteriaSupported: true, mappedItemsRequired: true, requiresCorpusKnowledge: true, unambiguous: true, answerLeakage: false, reason: 'Valid.' }, integrity: { directlyEntailed: true, contradictionChecked: true, qualificationsIncluded: true, authorityResolved: true, proxyAnswer: false, rationale: 'Checked.' } }) }; if (prompt.includes('Use only this complete source')) return { answer: 'two gigabytes' }; if (prompt.includes('Generate focused')) { const [item] = JSON.parse(prompt.split('KNOWLEDGE INVENTORY:\n')[1]); return { answer: JSON.stringify({ questions: [{ question: 'What is the limit?', type: 'fact', difficulty: 'easy', rubric: [{ criterion: 'States two gigabytes.', weight: 1, knowledgeItemIds: [item.knowledgeId] }] }] }) }; } return { answer: extractionResponses.shift() }; }, async version() { return 'test'; } };
  const datasetPath = await buildDataset({ corpusPath: corpus, outputRoot: path.join(root, 'datasets'), workRoot: path.join(root, 'extract-work'), options: { model: 'calibrated-subject', judgeModel: 'calibrated-judge', reasoningEffort: 'high' }, runner: extractionRunner });
  const subjectWorkspaces = [];
  const subjectPrompts = [];
  const pipelineCalls = [];
  let failSkillJudgmentOnce = true;
  const runner = {
    async listSkills(workspace) { return path.basename(workspace) === 'skill' ? [{ name: 'test-skill', source: 'project' }] : []; },
    async run(workspace, prompt) {
      if (prompt.includes('Judge the candidate answer')) {
        pipelineCalls.push(`judgment:${workspace.includes(`${path.sep}skill${path.sep}judge`) ? 'skill' : 'closedBook'}`);
        if (workspace.includes(`${path.sep}skill${path.sep}judge`) && failSkillJudgmentOnce) { failSkillJudgmentOnce = false; throw new Error('skill judgment interrupted'); }
        const candidate = JSON.parse(prompt.split('INPUT:\n')[1]).candidateAnswer;
        return { answer: JSON.stringify({ criterionResults: [{ criterionIndex: 0, score: candidate === 'two gigabytes' ? 1 : 0, rationale: 'Compared.' }], unsupportedClaims: [] }), durationSeconds: 0.1 };
      }
      pipelineCalls.push(`answer:${path.basename(workspace)}`);
      subjectWorkspaces.push(workspace);
      subjectPrompts.push({ workspace, prompt });
      return { answer: path.basename(workspace) === 'skill' ? 'two gigabytes' : 'unknown', durationSeconds: 0.1 };
    },
    async version() { return 'test'; },
  };
  const progressEvents = [];
  const baselineRoot = path.join(root, 'baselines');
  await assert.rejects(evaluateDataset({ datasetPath, skillPath: skill, baselineRoot, outputRoot: path.join(root, 'missing-runs'), workRoot: path.join(root, 'missing-work'), subjectRunner: runner, judgeRunner: runner }), /No compatible closed-book baseline[\s\S]*npm start -- eval baseline[\s\S]*--model calibrated-subject[\s\S]*--trials 3/);
  assert.deepEqual(pipelineCalls, []);
  const baselinePath = await evaluateBaseline({ datasetPath, outputRoot: baselineRoot, workRoot: path.join(root, 'baseline-work'), options: { concurrency: 1 }, subjectRunner: runner, judgeRunner: runner });
  assert.deepEqual(pipelineCalls, [
    'answer:closedBook', 'judgment:closedBook',
    'answer:closedBook', 'judgment:closedBook',
    'answer:closedBook', 'judgment:closedBook',
  ]);
  const baselineManifest = JSON.parse(await readFile(path.join(baselinePath, 'manifest.json'), 'utf8'));
  assert.equal(baselineManifest.model, 'calibrated-subject');
  assert.equal(baselineManifest.judgeModel, 'calibrated-judge');
  assert.equal(baselineManifest.reasoningEffort, 'high');
  pipelineCalls.length = 0;
  subjectWorkspaces.length = 0;
  subjectPrompts.length = 0;
  const evaluationOptions = { datasetPath, skillPath: skill, baselineRoot, outputRoot: path.join(root, 'runs'), workRoot: path.join(root, 'eval-work'), options: { concurrency: 1 }, subjectRunner: runner, judgeRunner: runner, progress: (event) => progressEvents.push(event) };
  await assert.rejects(evaluateDataset(evaluationOptions), /skill judgment interrupted/);
  assert.deepEqual(pipelineCalls, [
    'answer:skill', 'judgment:skill',
    'answer:skill', 'judgment:skill',
    'answer:skill', 'judgment:skill',
  ]);
  const automaticSkillPrompt = subjectPrompts.find((item) => path.basename(item.workspace) === 'skill').prompt;
  assert.doesNotMatch(automaticSkillPrompt, /^\/test-skill\b/);
  subjectWorkspaces.length = 0;
  subjectPrompts.length = 0;
  const runPath = await evaluateDataset(evaluationOptions);
  const summary = JSON.parse(await readFile(path.join(runPath, 'summary.json'), 'utf8'));
  assert.deepEqual(summary.conditionScores, { closedBook: 0, skill: 1 });
  assert.equal(summary.datasetCeiling, 1);
  assert.equal(summary.diagnosedFailures, 0);
  assert.equal(subjectWorkspaces.length, 0);
  const journal = await OperationJournal.open(path.join(root, 'eval-work', 'operations.sqlite'), { readOnly: true });
  const [operation] = journal.listOperations();
  assert.deepEqual(journal.listJobs(operation.operationId).map((job) => job.stage).sort(), ['answer', 'answer', 'answer', 'judgment', 'judgment', 'judgment']);
  journal.close();
  const automaticManifest = JSON.parse(await readFile(path.join(runPath, 'manifest.json'), 'utf8'));
  assert.equal(automaticManifest.skillInvocation, 'auto');
  assert.equal(automaticManifest.evaluatorVersion, '0.8.0');
  assert.equal(automaticManifest.baselineId, baselineManifest.baselineId);
  assert.equal(automaticManifest.trialsPerQuestion, 3);
  assert.equal(automaticManifest.model, 'calibrated-subject');
  assert.equal(automaticManifest.judgeModel, 'calibrated-judge');
  const reportPath = await generateEvaluationReport({ runPath, datasetPath, title: 'Test skill' });
  const report = await readFile(reportPath, 'utf8');
  assert.match(report, /const report = \{"title":"Test skill"/);
  assert.match(report, /"documents":1,"knowledge":1,"questions":1,"judgments":6,"fullyCorrect":1/);
  assert.doesNotMatch(report, /__SKILLFID_REPORT_DATA__/);
  assert.ok(progressEvents.some((event) => event.progress?.label === 'questions evaluated'));
  assert.ok(progressEvents.some((event) => /\d+ jobs? queued/.test(event.current)));
  assert.ok(progressEvents.some((event) => /\d+ answers? in progress/.test(event.current)));
  assert.ok(progressEvents.some((event) => /\d+ judgments? in progress/.test(event.current)));
  assert.ok(progressEvents.some((event) => event.progress?.done === 1 && event.progress?.total === 1));
  assert.ok(Math.max(...progressEvents.map((event) => Number(event.current?.match(/^(\d+) jobs? queued/)?.[1] ?? 0))) <= 6);

  subjectPrompts.length = 0;
  const explicitRunPath = await evaluateDataset({ datasetPath, skillPath: skill, baselineRoot, outputRoot: path.join(root, 'explicit-runs'), workRoot: path.join(root, 'explicit-work'), options: { skillInvocation: 'explicit' }, subjectRunner: runner, judgeRunner: runner });
  const explicitSkillPrompt = subjectPrompts.find((item) => path.basename(item.workspace) === 'skill').prompt;
  assert.match(explicitSkillPrompt, /^\/test-skill\n\nAnswer the user's question\./);
  const explicitManifest = JSON.parse(await readFile(path.join(explicitRunPath, 'manifest.json'), 'utf8'));
  assert.equal(explicitManifest.skillInvocation, 'explicit');
});