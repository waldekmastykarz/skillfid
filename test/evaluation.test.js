import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import path from 'node:path';

import { EXIT_CODES } from '../src/errors.js';
import { evaluateBaseline, evaluateDataset, EvaluationError, formatScore, summarizeCriterionFailures } from '../src/evaluation.js';
import { OperationJournal } from '../src/journal.js';
import { readJson, readJsonl } from '../src/files.js';
import { createFakeRunner, writeDatasetFixture, writeSkill } from './helpers/fixtures.js';

const root = '.work/js-tests/evaluation';
afterEach(async () => rm(root, { recursive: true, force: true }));

async function prepare(name) {
  const base = path.join(root, name);
  const { datasetPath } = await writeDatasetFixture(path.join(base, 'datasets'));
  const skill = await writeSkill(path.join(base, 'skill'));
  return { base, datasetPath, skill, baselineRoot: path.join(base, 'baselines') };
}

async function makeBaseline(env, { trials = 1, runner = createFakeRunner(), name = 'baseline-work' } = {}) {
  return evaluateBaseline({ datasetPath: env.datasetPath, outputRoot: env.baselineRoot, workRoot: path.join(env.base, name), options: { concurrency: 2, trialsPerQuestion: trials }, subjectRunner: runner, judgeRunner: runner });
}

function run(env, { runner = createFakeRunner(), options = {}, name = 'runs', work = 'eval-work', progress } = {}) {
  return evaluateDataset({ datasetPath: env.datasetPath, skillPath: env.skill, baselineRoot: env.baselineRoot, outputRoot: path.join(env.base, name), workRoot: path.join(env.base, work), options: { concurrency: 3, trialsPerQuestion: 2, ...options }, subjectRunner: runner, judgeRunner: runner, progress });
}

const testId = (key) => `ke_${key}`;
const skillTrace = (...files) => ({ skillLoaded: true, filesRead: files.map((file) => ({ path: `.github/skills/skill/${file}`, bytes: 100 })), toolCalls: [], turns: 2, inputTokens: 10, outputTokens: 2 });

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

test('requires a baseline, reuses a one-trial baseline for any skill trial count, and records traces and statistics', async () => {
  const env = await prepare('reuse');
  const calls = [];
  const runner = createFakeRunner({ calls });
  await assert.rejects(run(env, { runner }), (error) => {
    assert.ok(error instanceof EvaluationError);
    assert.equal(error.code, 'BASELINE_MISSING');
    assert.match(error.command, /^npm start -- eval baseline --dataset .*--model calibrated-subject --judge-model calibrated-judge --reasoning-effort high$/);
    assert.match(error.message, /No compatible closed-book baseline[\s\S]*npm start -- eval baseline/);
    assert.equal(error.exitCode, EXIT_CODES.failure);
    return true;
  });
  assert.equal(calls.filter((call) => call.role === 'subject').length, 0);

  const baselinePath = await makeBaseline(env, { runner });
  assert.equal(calls.filter((call) => call.role === 'subject').length, 5);
  assert.equal((await readJsonl(path.join(baselinePath, 'answers.jsonl'))).length, 5);
  calls.length = 0;
  const events = [];
  const runPath = await run(env, { runner, options: { trialsPerQuestion: 3 }, progress: (event) => events.push(event) });

  assert.equal(calls.filter((call) => call.role === 'subject').length, 15);
  const summary = await readJson(path.join(runPath, 'summary.json'));
  assert.deepEqual(summary.conditionScores, { closedBook: 0, skill: 1 });
  assert.equal(summary.questions, 5);
  assert.equal(summary.partial, undefined);
  assert.equal(summary.statistics.skill.n, 5);
  assert.equal(summary.statistics.uplift.mean, 1);
  assert.equal(summary.statistics.skillNoise.answerVariability, 0);
  assert.equal(summary.progressiveDisclosure.skillLoadedRate, 1);
  assert.equal(summary.progressiveDisclosure.meanFilesRead, 1);
  assert.equal(summary.diagnosedFailures, 0);
  assert.equal(summary.usage.skill.meanInputTokens, 100);
  const answers = await readJsonl(path.join(runPath, 'answers.jsonl'));
  const skillAnswers = answers.filter((answer) => answer.condition === 'skill');
  assert.equal(skillAnswers.length, 15);
  assert.equal(skillAnswers[0].trace.skillLoaded, true);
  assert.equal(skillAnswers[0].disclosure.filesRead, 1);
  assert.equal(skillAnswers[0].stage, undefined);
  assert.equal(answers.filter((answer) => answer.condition === 'closedBook').length, 5);
  const manifest = await readJson(path.join(runPath, 'manifest.json'));
  assert.equal(manifest.evaluatorVersion, '0.9.0');
  assert.deepEqual(Object.keys(manifest.skillFiles).sort(), ['SKILL.md', 'references/facts.md']);
  assert.equal(manifest.trialsPerQuestion, 3);
  assert.equal(manifest.partial, undefined);
  assert.ok(events.some((event) => event.metrics && 'answering' in event.metrics && 'failed' in event.metrics));
  assert.ok(events.some((event) => /latest: “What is the size limit\?”/.test(event.current ?? '')));
  assert.ok(events.some((event) => event.metrics?.skillLoadedRate === '100%'));
  assert.ok(events.some((event) => event.progress?.done === 5 && event.progress?.total === 5));
});

test('a baseline with more trials is reused by a single-trial skill run and uplift uses the per-question mean', async () => {
  const env = await prepare('baseline-trials');
  let toggle = 0;
  const runner = createFakeRunner({ behavior: (question, { kind }) => (kind === 'closedBook' && question === 'What is the size limit?' ? { answer: toggle++ % 2 === 0 ? 'two gigabytes' : 'unknown' } : {}) });
  await makeBaseline(env, { trials: 2, runner });
  const runPath = await run(env, { runner, options: { trialsPerQuestion: 1 } });
  const answers = await readJsonl(path.join(runPath, 'answers.jsonl'));
  assert.equal(answers.filter((answer) => answer.condition === 'closedBook').length, 10);
  const summary = await readJson(path.join(runPath, 'summary.json'));
  assert.equal(summary.conditionScores.closedBook, 0.5 / 5);
  assert.ok(Math.abs(summary.skillUplift - (1 - 0.1)) < 1e-12);
});

test('resumes interrupted work from the journal without repeating answers', async () => {
  const env = await prepare('resume');
  const calls = [];
  const runner = createFakeRunner({ calls });
  await makeBaseline(env, { runner });
  let failOnce = true;
  const flaky = { ...runner, run: async (workspace, prompt) => {
    if (failOnce && prompt.includes('Judge the candidate answer') && workspace.includes(`${path.sep}skill${path.sep}judge`)) { failOnce = false; throw new Error('skill judgment interrupted'); }
    return runner.run(workspace, prompt);
  } };
  await assert.rejects(run(env, { runner: flaky, options: { concurrency: 1, trialsPerQuestion: 1 } }), /skill judgment interrupted/);
  const interrupted = await OperationJournal.open(path.join(env.base, 'eval-work', 'operations.sqlite'), { readOnly: true });
  const [operation] = interrupted.listOperations();
  assert.equal(operation.status, 'failed');
  assert.ok(interrupted.listJobs(operation.operationId).some((job) => job.status === 'failed' && /interrupted/.test(job.error)));
  assert.ok(interrupted.listJobs(operation.operationId).every((job) => job.label));
  interrupted.close();
  const answeredBefore = calls.filter((call) => call.role === 'subject' && call.kind === 'skill').length;
  const runPath = await run(env, { runner, options: { concurrency: 1, trialsPerQuestion: 1 } });
  const answeredAfter = calls.filter((call) => call.role === 'subject' && call.kind === 'skill').length;
  assert.ok(answeredAfter - answeredBefore < 5, 'answers completed before the interruption are reused');
  assert.equal((await readJson(path.join(runPath, 'summary.json'))).conditionScores.skill, 1);
  const journal = await OperationJournal.open(path.join(env.base, 'eval-work', 'operations.sqlite'), { readOnly: true });
  assert.equal(journal.listOperations()[0].status, 'completed');
  journal.close();
});

test('classifies failing skill trials into failure stages and feeds them to the diagnosis', async () => {
  const env = await prepare('stages');
  const calls = [];
  const behavior = (question, { kind }) => {
    if (kind !== 'skill') return {};
    switch (question) {
      case 'What is the size limit?': return { answer: 'wrong', trace: { ...skillTrace(), skillLoaded: false, filesRead: [] } };
      case 'How long is data kept?': return { answer: 'wrong', trace: skillTrace('SKILL.md') };
      case 'How often does billing happen?': return { answer: 'I do not know.', trace: skillTrace('SKILL.md', 'references/facts.md') };
      case 'When is support available?': return { answer: 'wrong INVENTED', trace: skillTrace('references/facts.md') };
      default: return { answer: 'wrong', trace: skillTrace('references/facts.md') };
    }
  };
  const runner = createFakeRunner({ calls, behavior });
  await makeBaseline(env, { runner });
  const runPath = await run(env, { runner, options: { trialsPerQuestion: 1 } });
  const answers = (await readJsonl(path.join(runPath, 'answers.jsonl'))).filter((answer) => answer.condition === 'skill');
  const stageOf = (key) => answers.find((answer) => answer.testId === testId(key)).stage;
  assert.equal(stageOf('limit'), 'not_discovered');
  assert.equal(stageOf('retention'), 'retrieval_miss');
  assert.equal(stageOf('billing'), 'false_refusal');
  assert.equal(stageOf('support'), 'hallucination');
  assert.equal(stageOf('security'), 'application_error');
  const summary = await readJson(path.join(runPath, 'summary.json'));
  assert.deepEqual(summary.failureStages, { not_discovered: 1, retrieval_miss: 1, false_refusal: 1, hallucination: 1, application_error: 1, unknown: 0 });
  assert.equal(summary.conditionScores.skill, 0);
  const audit = calls.find((call) => call.role === 'audit' && call.prompt.includes('observedFailureStages'));
  assert.ok(audit, 'the audit prompt carries the observed stages');
  const diagnoses = await readJsonl(path.join(runPath, 'diagnoses.jsonl'));
  assert.equal(diagnoses.length, 5);
  assert.deepEqual(diagnoses.find((item) => item.testId === testId('retention')).failureStages, { retrieval_miss: 1 });
  assert.ok(diagnoses.every((item) => item.category === 'skill_knowledge_gap'));
});

test('--sample and --filter produce deterministic partial runs that reuse the full baseline', async () => {
  const env = await prepare('subset');
  const runner = createFakeRunner();
  await makeBaseline(env, { runner });
  const first = await run(env, { runner, options: { trialsPerQuestion: 1, sample: 3, seed: 7 }, name: 'sampled-a', work: 'work-a' });
  const second = await run(env, { runner, options: { trialsPerQuestion: 1, sample: 3, seed: 7 }, name: 'sampled-b', work: 'work-b' });
  const manifest = await readJson(path.join(first, 'manifest.json'));
  assert.equal(manifest.partial, true);
  assert.deepEqual(manifest.subset, { questions: 3, of: 5, sample: { n: 3, seed: 7 } });
  assert.equal(manifest.sample.testIds.length, 3);
  assert.deepEqual((await readJson(path.join(second, 'manifest.json'))).sample.testIds, manifest.sample.testIds);
  const summary = await readJson(path.join(first, 'summary.json'));
  assert.equal(summary.partial, true);
  assert.equal(summary.questions, 3);
  assert.equal((await readJsonl(path.join(first, 'answers.jsonl'))).filter((answer) => answer.condition === 'closedBook').length, 3);
  assert.ok(new Set((await readJsonl(path.join(first, 'answers.jsonl'))).map((answer) => answer.testId)).size === 3);

  const filtered = await run(env, { runner, options: { trialsPerQuestion: 1, filter: 'type=fact,importance=high' }, name: 'filtered', work: 'work-f' });
  const filteredManifest = await readJson(path.join(filtered, 'manifest.json'));
  assert.equal(filteredManifest.subset.questions, 1);
  assert.equal(filteredManifest.filter, 'type=fact,importance=high');
  assert.deepEqual([...new Set((await readJsonl(path.join(filtered, 'answers.jsonl'))).map((answer) => answer.testId))], [testId('limit')]);
  await assert.rejects(run(env, { runner, options: { filter: 'type=nonexistent' }, name: 'none', work: 'work-n' }), /matched no questions/);
  await assert.rejects(run(env, { runner, options: { filter: 'colour=red' }, name: 'bad', work: 'work-b2' }), /Unknown --filter key/);
});

test('--adaptive runs the remaining trials only for questions that missed trial 0', async () => {
  const env = await prepare('adaptive');
  const calls = [];
  const runner = createFakeRunner({ calls, behavior: (question, { kind }) => (kind === 'skill' && question === 'How long is data kept?' ? { answer: 'wrong', trace: skillTrace('SKILL.md') } : {}) });
  await makeBaseline(env, { runner });
  calls.length = 0;
  const runPath = await run(env, { runner, options: { trialsPerQuestion: 3, adaptive: true } });
  const manifest = await readJson(path.join(runPath, 'manifest.json'));
  assert.equal(manifest.adaptive, true);
  assert.equal(manifest.trialsRun[testId('retention')], 3);
  assert.equal(manifest.trialsRun[testId('limit')], 1);
  assert.equal(calls.filter((call) => call.role === 'subject' && call.kind === 'skill').length, 4 * 1 + 3);
  const summary = await readJson(path.join(runPath, 'summary.json'));
  assert.equal(summary.conditionScores.closedBook, 0);
  assert.ok(Math.abs(summary.conditionScores.skill - 0.8) < 1e-12);
});

test('--since carries forward unaffected questions and reruns failures, unloaded skills and changed reads', async () => {
  const env = await prepare('since');
  const calls = [];
  const behavior = (question, { kind }) => {
    if (kind !== 'skill') return {};
    if (question === 'What is the size limit?') return { trace: skillTrace('SKILL.md', 'references/facts.md') };
    if (question === 'How often do keys rotate?') return { answer: 'wrong', trace: skillTrace('SKILL.md') };
    if (question === 'When is support available?') return { trace: { ...skillTrace(), skillLoaded: false, filesRead: [] } };
    return { trace: skillTrace('SKILL.md') };
  };
  const runner = createFakeRunner({ calls, behavior });
  await makeBaseline(env, { runner });
  const previous = await run(env, { runner, options: { trialsPerQuestion: 1 }, name: 'previous', work: 'work-1' });
  await writeFile(path.join(env.skill, 'references', 'facts.md'), `${(await readFile(path.join(env.skill, 'references', 'facts.md'), 'utf8'))}\nNew line.\n`);
  await writeFile(path.join(env.skill, 'references', 'extra.md'), 'Extra.\n');
  calls.length = 0;
  const next = await run(env, { runner, options: { trialsPerQuestion: 1, since: previous }, name: 'next', work: 'work-2' });
  const manifest = await readJson(path.join(next, 'manifest.json'));
  const previousManifest = await readJson(path.join(previous, 'manifest.json'));
  assert.deepEqual(manifest.incremental, { since: previousManifest.runId, rerun: 3, carried: 2, changedFiles: { changed: ['references/facts.md'], added: ['references/extra.md'], removed: [] } });
  assert.deepEqual(calls.filter((call) => call.role === 'subject' && call.kind === 'skill').map((call) => call.question).sort(), ['How often do keys rotate?', 'What is the size limit?', 'When is support available?']);
  const answers = (await readJsonl(path.join(next, 'answers.jsonl'))).filter((answer) => answer.condition === 'skill');
  assert.equal(answers.length, 5);
  assert.deepEqual(answers.filter((answer) => answer.carriedFrom).map((answer) => answer.testId).sort(), [testId('billing'), testId('retention')]);
  assert.ok(answers.filter((answer) => answer.carriedFrom).every((answer) => answer.carriedFrom === previousManifest.runId));
  assert.equal((await readJsonl(path.join(next, 'judgments.jsonl'))).filter((judgment) => judgment.carriedFrom).length, 2);
  assert.equal((await readJson(path.join(next, 'summary.json'))).questions, 5);
  assert.deepEqual((await readJson(path.join(next, 'summary.json'))).incremental, { since: previousManifest.runId, rerun: 3, carried: 2 });

  await writeFile(path.join(env.skill, 'SKILL.md'), '# Changed\n');
  calls.length = 0;
  const everything = await run(env, { runner, options: { trialsPerQuestion: 1, since: next }, name: 'all', work: 'work-3' });
  assert.equal((await readJson(path.join(everything, 'manifest.json'))).incremental.rerun, 5);
  assert.equal(calls.filter((call) => call.role === 'subject' && call.kind === 'skill').length, 5);
});

test('--since rejects runs that cannot be carried forward', async () => {
  const env = await prepare('since-invalid');
  const runner = createFakeRunner();
  await makeBaseline(env, { runner });
  const previous = await run(env, { runner, options: { trialsPerQuestion: 1 }, name: 'previous', work: 'work-1' });
  await assert.rejects(run(env, { runner, options: { since: path.join(env.base, 'missing') }, name: 'a', work: 'work-2' }), (error) => error.code === 'SINCE_INVALID');
  await assert.rejects(run(env, { runner, options: { since: previous, skillInvocation: 'explicit' }, name: 'b', work: 'work-3' }), (error) => error.code === 'SINCE_INCOMPATIBLE');
  const manifestPath = path.join(previous, 'manifest.json');
  const manifest = await readJson(manifestPath);
  delete manifest.skillFiles;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(run(env, { runner, options: { since: previous }, name: 'c', work: 'work-4' }), /did not record skillFiles/);
});

test('probes are judged separately and never change the accuracy numbers', async () => {
  const env = await prepare('probes');
  const probesPath = path.join(env.base, 'probes.jsonl');
  await writeFile(probesPath, [
    JSON.stringify({ id: 'out-of-scope', question: 'Who won the 1998 World Cup?', expect: 'refuse', behaviors: ['Says it is not covered'] }),
    JSON.stringify({ id: 'in-scope', question: 'What is the size limit?', expect: 'answer', behaviors: ['CITED'] }),
  ].join('\n'));
  const behavior = (question, { kind }) => (kind === 'skill' && question === 'Who won the 1998 World Cup?' ? { answer: 'INVENTED: France CITED' } : kind === 'skill' && question === 'What is the size limit?' ? { answer: 'two gigabytes CITED' } : {});
  const calls = [];
  const runner = createFakeRunner({ calls, behavior });
  await makeBaseline(env, { runner });
  const runPath = await run(env, { runner, options: { trialsPerQuestion: 2, probesPath } });
  const records = await readJsonl(path.join(runPath, 'probes.jsonl'));
  assert.equal(records.length, 4);
  assert.deepEqual(records.map((record) => `${record.probeId}:${record.trial}`), ['out-of-scope:0', 'out-of-scope:1', 'in-scope:0', 'in-scope:1']);
  const outOfScope = records.find((record) => record.probeId === 'out-of-scope');
  assert.equal(outOfScope.refused, false);
  assert.equal(outOfScope.hallucinated, true);
  assert.equal(outOfScope.passed, false);
  assert.equal(outOfScope.behaviors[0].passed, true);
  assert.equal(records.find((record) => record.probeId === 'in-scope').passed, true);
  const summary = await readJson(path.join(runPath, 'summary.json'));
  assert.deepEqual(summary.probes, { total: 2, trials: 4, correctRefusalRate: 0, hallucinationRate: 0.5, behaviorPassRate: 1, answeredWhenExpectedRate: 1 });
  assert.equal(summary.conditionScores.skill, 1);
  assert.equal(summary.questions, 5);
  assert.equal((await readJsonl(path.join(runPath, 'answers.jsonl'))).filter((answer) => answer.condition === 'skill').length, 10);
  const journal = await OperationJournal.open(path.join(env.base, 'eval-work', 'operations.sqlite'), { readOnly: true });
  const stages = new Set(journal.listJobs(journal.listOperations()[0].operationId).map((job) => job.stage));
  assert.ok(stages.has('probe') && stages.has('probe_judgment'));
  journal.close();
  assert.equal((await readJson(path.join(runPath, 'manifest.json'))).probes.count, 2);
});

test('records the gate result when --fail-under is set', async () => {
  const env = await prepare('gate');
  const runner = createFakeRunner({ behavior: (question, { kind }) => (kind === 'skill' && question === 'How long is data kept?' ? { answer: 'wrong' } : {}) });
  await makeBaseline(env, { runner });
  const failing = await run(env, { runner, options: { trialsPerQuestion: 1, failUnder: 0.9 }, name: 'a', work: 'w1' });
  assert.deepEqual((await readJson(path.join(failing, 'summary.json'))).gate, { passed: false, threshold: 0.9, score: 0.8 });
  const passing = await run(env, { runner, options: { trialsPerQuestion: 1, failUnder: 0.8 }, name: 'b', work: 'w2' });
  assert.equal((await readJson(path.join(passing, 'summary.json'))).gate.passed, true);
  const none = await run(env, { runner, options: { trialsPerQuestion: 1 }, name: 'c', work: 'w3' });
  assert.equal((await readJson(path.join(none, 'summary.json'))).gate, undefined);
});

test('explicit skill invocation prefixes the skill command', async () => {
  const env = await prepare('explicit');
  const calls = [];
  const runner = createFakeRunner({ calls });
  await makeBaseline(env, { runner });
  await run(env, { runner, options: { trialsPerQuestion: 1, skillInvocation: 'explicit' } });
  assert.match(calls.find((call) => call.kind === 'skill').prompt, /^\/test-skill\n\nAnswer the user's question\./);
  assert.doesNotMatch(calls.find((call) => call.kind === 'closedBook').prompt, /^\/test-skill/);
});
