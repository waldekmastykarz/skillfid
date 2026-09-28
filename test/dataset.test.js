import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import path from 'node:path';

import { buildDataset, estimateDatasetCalls, loadDataset, recalibrateDataset } from '../src/dataset.js';

const root = '.work/js-tests/dataset';
afterEach(async () => rm(root, { recursive: true, force: true }));
const calibration = (score = 1, integrity = {}, verification = {}) => JSON.stringify({ criterionResults: [{ criterionIndex: 0, score, rationale: score === 1 ? 'Complete.' : 'Incomplete.' }], unsupportedClaims: [], verification: { answerable: true, referenceSupported: true, criteriaSupported: true, mappedItemsRequired: true, requiresCorpusKnowledge: true, unambiguous: true, answerLeakage: false, reason: 'Structurally valid.', ...verification }, integrity: { directlyEntailed: true, contradictionChecked: true, qualificationsIncluded: true, authorityResolved: true, proxyAnswer: false, rationale: 'Checked the complete source.', ...integrity } });

test('builds and verifies an immutable, fully covered oracle-calibrated dataset', async () => {
  const corpus = path.join(root, 'corpus');
  await mkdir(corpus, { recursive: true });
  await writeFile(path.join(corpus, 'policy.md'), '# Limit\n\nUploads larger than two gigabytes are rejected.\n');
  const inventory = JSON.stringify({ classification: 'informational', reason: 'A constraint.', items: [{ kind: 'constraint', statement: 'Uploads cannot exceed two gigabytes.', importance: 'high', importanceReason: 'Enforced limit.', quote: 'Uploads larger than two gigabytes are rejected.' }] });
  const noMissing = JSON.stringify({ classification: 'non_informational', reason: 'No missing items.', items: [] });
  const verification = JSON.stringify({ answerable: true, referenceSupported: true, criteriaSupported: true, mappedItemsRequired: true, requiresCorpusKnowledge: true, unambiguous: true, answerLeakage: false, reason: 'Valid.' });
  const responses = [inventory, noMissing, noMissing, verification];
  const progress = [];
  let inventoryCalls = 0;
  let judgeCalls = 0;
  const runner = {
    async run(_workspace, prompt) {
      if (prompt.includes('Calibrate this question')) { judgeCalls += 1; return { answer: calibration() }; }
      if (prompt.includes('Use only this complete source')) return { answer: 'Uploads larger than two gigabytes are rejected.' };
      if (prompt.includes('Generate focused, independently scorable')) {
        const [item] = JSON.parse(prompt.split('KNOWLEDGE INVENTORY:\n')[1]);
        return { answer: JSON.stringify({ questions: [{ question: 'What upload size is rejected?', type: 'fact', difficulty: 'easy', rubric: [{ criterion: 'States the two-gigabyte limit.', weight: 1, knowledgeItemIds: [item.knowledgeId] }] }] }) };
      }
      inventoryCalls += 1;
      return { answer: responses.shift() };
    },
    async version() { return 'GitHub Copilot CLI test'; },
  };
  const datasetPath = await buildDataset({ corpusPath: corpus, outputRoot: path.join(root, 'datasets'), workRoot: path.join(root, 'work'), runner, progress: (message) => progress.push(message) });
  const manifest = JSON.parse(await readFile(path.join(datasetPath, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 6);
  assert.deepEqual(manifest.calibration, { model: 'gpt-5.6-sol', judgeModel: 'gpt-5.6-sol', reasoningEffort: 'medium', oraclePromptVersion: '3', judgeConsensus: { policyVersion: '1', initialJudgments: 3, additionalJudgmentsOnDisagreement: 2, supermajorityVotes: 4 }, requiredScore: 1 });
  const verificationProgress = [];
  const dataset = await loadDataset(datasetPath, { progress: (event) => verificationProgress.push(event) });
  assert.equal(dataset.questions.length, 1);
  assert.equal(dataset.calibrations[0].score, 1);
  assert.equal(judgeCalls, 3);
  assert.equal(dataset.calibrations[0].judgments.length, 3);
  assert.deepEqual(dataset.calibrations[0].judgeConsensus, { policyVersion: '1', verdict: 'pass', passVotes: 3, failVotes: 0, totalJudgments: 3 });
  assert.deepEqual(verificationProgress.map(({ done }) => done), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(verificationProgress.at(-1).current, 'Integrity verified');
  assert.equal(inventoryCalls, 2);
  assert.ok(progress.some((event) => event.progress?.done === 0 && event.progress?.total === 1));
  assert.ok(progress.some((event) => event.progress?.done === 1 && event.progress?.total === 1));
  assert.ok(progress.every((event) => !event.progress || event.progress.label === 'knowledge items covered'));
  assert.ok(progress.some((event) => event.type === 'complete' && event.title === 'Dataset built'));
  await writeFile(path.join(datasetPath, 'questions.jsonl'), '{}\n', { flag: 'a' });
  await assert.rejects(loadDataset(datasetPath), /content hash mismatch/);
});

test('regenerates a question whose oracle answer does not pass its rubric', async () => {
  const corpus = path.join(root, 'corpus');
  await mkdir(corpus, { recursive: true });
  await writeFile(path.join(corpus, 'policy.md'), '# Limit\n\nThe upload limit is two gigabytes.\n');
  const inventory = JSON.stringify({ classification: 'informational', reason: 'A fact.', items: [{ kind: 'fact', statement: 'The upload limit is two gigabytes.', importance: 'high', importanceReason: 'Limit.', quote: 'The upload limit is two gigabytes.' }] });
  const noMissing = JSON.stringify({ classification: 'non_informational', reason: 'Complete.', items: [] });
  const verification = JSON.stringify({ answerable: true, referenceSupported: true, criteriaSupported: true, mappedItemsRequired: true, requiresCorpusKnowledge: true, unambiguous: true, answerLeakage: false, reason: 'Valid.' });
  let generation = 0;
  const runner = {
    async run(_workspace, prompt) {
      if (prompt.includes('Generate focused, independently scorable')) {
        generation += 1;
        const [item] = JSON.parse(prompt.split('KNOWLEDGE INVENTORY:\n')[1].split('\n\nThe previous')[0]);
        return { answer: JSON.stringify({ questions: [{ question: generation < 4 ? 'What is configured?' : 'What is the upload limit?', type: 'fact', difficulty: 'easy', rubric: [{ criterion: 'States two gigabytes.', weight: 1, knowledgeItemIds: [item.knowledgeId] }] }] }) };
      }
      if (prompt.includes('Calibrate this question')) return { answer: calibration(generation < 4 ? 0 : 1) };
      if (prompt.includes('Use only this complete source')) return { answer: generation < 4 ? 'Unknown.' : 'Two gigabytes.' };
      if (prompt.includes('Independently verify')) return { answer: verification };
      return { answer: generation === 0 ? inventory : noMissing };
    },
    async version() { return 'test'; },
  };
  const datasetPath = await buildDataset({ corpusPath: corpus, outputRoot: path.join(root, 'datasets'), workRoot: path.join(root, 'work'), runner });
  const dataset = await loadDataset(datasetPath);
  assert.equal(generation, 4);
  assert.equal(dataset.questions[0].question, 'What is the upload limit?');
  assert.equal(dataset.calibrations[0].generationAttempt, 4);
});

test('runs sections concurrently and resumes completed sections after failure', async () => {
  const corpus = path.join(root, 'corpus');
  await mkdir(corpus, { recursive: true });
  await writeFile(path.join(corpus, 'alpha.md'), '# Alpha\n\nAlpha limit is one.\n');
  await writeFile(path.join(corpus, 'beta.md'), '# Beta\n\nBeta limit is two.\n');
  const calls = { alpha: 0, beta: 0 };
  let active = 0;
  let peak = 0;
  let failBeta = true;
  const runner = {
    async run(_workspace, prompt) {
      const name = prompt.includes('Alpha limit') ? 'alpha' : prompt.includes('Beta limit') ? 'beta' : undefined;
      if (name) calls[name] += 1;
      active += 1;
      peak = Math.max(peak, active);
      const firstSectionCall = name && calls[name] === 1;
      for (let turn = 0; turn < (firstSectionCall ? 100 : 1) && (!calls.alpha || !calls.beta); turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      active -= 1;
      if (name === 'beta' && failBeta) throw new Error('interrupted beta');
      if (prompt.includes('Inventory every independently testable')) {
        const existing = JSON.parse(prompt.split('EXISTING ITEMS:\n')[1].split('\nSOURCE SECTION:')[0]);
        if (existing.length) return { answer: JSON.stringify({ classification: 'non_informational', reason: 'Complete.', items: [] }) };
        const title = name === 'alpha' ? 'Alpha' : 'Beta';
        const value = name === 'alpha' ? 'one' : 'two';
        return { answer: JSON.stringify({ classification: 'informational', reason: 'A fact.', items: [{ kind: 'fact', statement: `${title} limit is ${value}.`, importance: 'high', importanceReason: 'Limit.', quote: `${title} limit is ${value}.` }] }) };
      }
      if (prompt.includes('Generate focused')) {
        const [item] = JSON.parse(prompt.split('KNOWLEDGE INVENTORY:\n')[1]);
        return { answer: JSON.stringify({ questions: [{ question: `What is the ${name} limit?`, type: 'fact', difficulty: 'easy', rubric: [{ criterion: 'States the limit.', weight: 1, knowledgeItemIds: [item.knowledgeId] }] }] }) };
      }
      if (prompt.includes('Independently verify')) return { answer: JSON.stringify({ answerable: true, referenceSupported: true, criteriaSupported: true, mappedItemsRequired: true, requiresCorpusKnowledge: true, unambiguous: true, answerLeakage: false, reason: 'Valid.' }) };
      if (prompt.includes('Use only this complete source')) return { answer: `${name} answer` };
      if (prompt.includes('Calibrate this question')) return { answer: calibration() };
      throw new Error('Unexpected prompt');
    },
    async version() { return 'test'; },
  };
  let options = { concurrency: 10, resume: false };
  const build = () => buildDataset({ corpusPath: corpus, outputRoot: path.join(root, 'datasets'), workRoot: path.join(root, 'work'), runner, options });
  await assert.rejects(build(), /interrupted beta/);
  assert.ok(peak > 1);
  const alphaCallsAfterFailure = calls.alpha;
  failBeta = false;
  options = { concurrency: 10, resume: true };
  const dataset = await loadDataset(await build());
  assert.equal(dataset.questions.length, 2);
  assert.equal(calls.alpha, alphaCallsAfterFailure);
  assert.ok(calls.beta > 1);
});

test('rejects a proxy oracle answer despite a perfect rubric score', async () => {
  const corpus = path.join(root, 'corpus');
  await mkdir(corpus, { recursive: true });
  await writeFile(path.join(corpus, 'policy.md'), '# Policy\n\nLocal guidance says one. Later authoritative guidance says two.\n');
  const inventory = JSON.stringify({ classification: 'informational', reason: 'A fact.', items: [{ kind: 'fact', statement: 'Authoritative guidance says two.', importance: 'high', importanceReason: 'Authority.', quote: 'Later authoritative guidance says two.' }] });
  const noMissing = JSON.stringify({ classification: 'non_informational', reason: 'Complete.', items: [] });
  let generation = 0;
  const runner = {
    async run(_workspace, prompt) {
      if (prompt.includes('Inventory every')) { const existing = JSON.parse(prompt.split('EXISTING ITEMS:\n')[1].split('\nSOURCE SECTION:')[0]); return { answer: existing.length ? noMissing : inventory }; }
      if (prompt.includes('Generate focused')) { generation += 1; const [item] = JSON.parse(prompt.split('KNOWLEDGE INVENTORY:\n')[1].split('\n\nThe previous')[0]); return { answer: JSON.stringify({ questions: [{ question: `What value applies${generation}?`, type: 'fact', difficulty: 'easy', rubric: [{ criterion: 'States the value.', weight: 1, knowledgeItemIds: [item.knowledgeId] }] }] }) }; }
      if (prompt.includes('Independently verify')) return { answer: JSON.stringify({ answerable: true, referenceSupported: true, criteriaSupported: true, mappedItemsRequired: true, requiresCorpusKnowledge: true, unambiguous: true, answerLeakage: false, reason: 'Valid.' }) };
      if (prompt.includes('Use only this complete source')) return { answer: generation === 1 ? 'One.' : 'Two.' };
      if (prompt.includes('Calibrate this question')) return { answer: generation === 1 ? calibration(1, { directlyEntailed: false, proxyAnswer: true, rationale: 'The answer matches a local fragment but conflicts with authoritative guidance.' }) : calibration() };
      throw new Error('Unexpected prompt');
    },
    async version() { return 'test'; },
  };
  const dataset = await loadDataset(await buildDataset({ corpusPath: corpus, outputRoot: path.join(root, 'datasets'), workRoot: path.join(root, 'work'), runner }));
  assert.equal(generation, 2);
  assert.equal(dataset.calibrations[0].integrity.passed, true);
});

test('recalibrates published questions without rerunning extraction', async () => {
  const corpus = path.join(root, 'corpus');
  await mkdir(corpus, { recursive: true });
  await writeFile(path.join(corpus, 'policy.md'), '# Limit\n\nUploads larger than two gigabytes are rejected.\n');
  const inventory = JSON.stringify({ classification: 'informational', reason: 'A constraint.', items: [{ kind: 'constraint', statement: 'Uploads cannot exceed two gigabytes.', importance: 'high', importanceReason: 'Enforced limit.', quote: 'Uploads larger than two gigabytes are rejected.' }] });
  const noMissing = JSON.stringify({ classification: 'non_informational', reason: 'Complete.', items: [] });
  const buildRunner = {
    async run(_workspace, prompt) {
      if (prompt.includes('Inventory every')) { const existing = JSON.parse(prompt.split('EXISTING ITEMS:\n')[1].split('\nSOURCE SECTION:')[0]); return { answer: existing.length ? noMissing : inventory }; }
      if (prompt.includes('Generate focused')) { const [item] = JSON.parse(prompt.split('KNOWLEDGE INVENTORY:\n')[1]); return { answer: JSON.stringify({ questions: [{ question: 'What upload size is rejected?', type: 'fact', difficulty: 'easy', rubric: [{ criterion: 'States two gigabytes.', weight: 1, knowledgeItemIds: [item.knowledgeId] }] }] }) }; }
      if (prompt.includes('Independently verify')) return { answer: JSON.stringify({ answerable: true, referenceSupported: true, criteriaSupported: true, mappedItemsRequired: true, requiresCorpusKnowledge: true, unambiguous: true, answerLeakage: false, reason: 'Valid.' }) };
      if (prompt.includes('Use only this complete source')) return { answer: 'Two gigabytes.' };
      if (prompt.includes('Calibrate this question')) return { answer: calibration() };
      throw new Error('Unexpected prompt');
    },
    async version() { return 'GitHub Copilot CLI old.'; },
  };
  const sourcePath = await buildDataset({ corpusPath: corpus, outputRoot: path.join(root, 'datasets'), workRoot: path.join(root, 'build-work'), runner: buildRunner });
  const originalQuestions = await readFile(path.join(sourcePath, 'questions.jsonl'), 'utf8');
  const originalEvidence = await readFile(path.join(sourcePath, 'evidence.jsonl'), 'utf8');
  let extractionCalls = 0;
  let judgeCalls = 0;
  const oraclePrompts = [];
  const recalibrationRunner = {
    async run(_workspace, prompt) {
      if (prompt.includes('Inventory every') || prompt.includes('Generate focused')) extractionCalls += 1;
      if (prompt.includes('Use only this complete source')) { oraclePrompts.push(prompt); return { answer: 'Two gigabytes.' }; }
      if (prompt.includes('Calibrate this question')) { judgeCalls += 1; return { answer: calibration(judgeCalls === 3 ? 0 : 1) }; }
      throw new Error('Unexpected recalibration prompt');
    },
    async version() { return 'GitHub Copilot CLI new.'; },
  };
  const progressEvents = [];

  const recalibratedPath = await recalibrateDataset({ datasetPath: sourcePath, outputRoot: path.join(root, 'datasets'), workRoot: path.join(root, 'recalibration-work'), runner: recalibrationRunner, progress: (event) => progressEvents.push(event) });
  const recalibrated = await loadDataset(recalibratedPath);

  assert.notEqual(recalibratedPath, sourcePath);
  assert.equal(recalibrated.manifest.sourceDatasetId, path.basename(sourcePath));
  assert.equal(recalibrated.manifest.copilotCliVersion, 'GitHub Copilot CLI new.');
  assert.equal(recalibrated.manifest.calibration.oraclePromptVersion, '3');
  assert.equal(recalibrated.calibrations[0].runtime.copilotCliVersion, 'GitHub Copilot CLI new.');
  assert.equal(recalibrated.calibrations[0].runtime.oraclePromptVersion, '3');
  assert.equal(recalibrated.calibrations[0].judgments.length, 5);
  assert.deepEqual(recalibrated.calibrations[0].judgeConsensus, { policyVersion: '1', verdict: 'pass', passVotes: 4, failVotes: 1, totalJudgments: 5 });
  assert.equal(await readFile(path.join(recalibratedPath, 'questions.jsonl'), 'utf8'), originalQuestions);
  assert.equal(await readFile(path.join(recalibratedPath, 'evidence.jsonl'), 'utf8'), originalEvidence);
  assert.equal(extractionCalls, 0);
  assert.equal(oraclePrompts.length, recalibrated.questions.length);
  assert.ok(oraclePrompts.every((prompt) => prompt.includes('Calibration coverage requirements:')));
  assert.match(progressEvents[0].current, /extraction will not run/);
  assert.deepEqual(progressEvents.find((event) => event.progress?.total === 1)?.progress, { done: 0, total: 1, label: 'existing questions' });
  assert.doesNotMatch(progressEvents.map((event) => event.current ?? '').join('\n'), new RegExp(recalibrated.questions[0].testId));
  assert.match(progressEvents.at(-1).title, /without extraction/);
  assert.match(progressEvents.at(-1).summary.join('\n'), /GitHub Copilot CLI old\. → GitHub Copilot CLI new\./);

  let unstableJudgeCalls = 0;
  const unstableRunner = {
    async run(_workspace, prompt) {
      if (prompt.includes('Use only this complete source')) return { answer: 'Two gigabytes.' };
      if (prompt.includes('Calibrate this question')) {
        unstableJudgeCalls += 1;
        return { answer: calibration([1, 1, 0, 0, 1][unstableJudgeCalls - 1]) };
      }
      throw new Error('Unexpected unstable recalibration prompt');
    },
    async version() { return 'GitHub Copilot CLI unstable.'; },
  };
  await assert.rejects(
    recalibrateDataset({ datasetPath: sourcePath, outputRoot: path.join(root, 'datasets'), workRoot: path.join(root, 'unstable-work'), runner: unstableRunner }),
    /consensus=unstable; votes=3\/5/,
  );
  assert.equal(unstableJudgeCalls, 5);
});
test('a failing build does not delete workspaces of a concurrent build sharing the work directory', async () => {
  const corpus = path.join(root, 'corpus');
  await mkdir(corpus, { recursive: true });
  await writeFile(path.join(corpus, 'policy.md'), '# Limit\n\nThe upload limit is two gigabytes.\n');
  const workRoot = path.join(root, 'shared-work');
  let releaseSurvivor;
  const failedBuildFinished = new Promise((resolve) => { releaseSurvivor = resolve; });
  const failing = { async run() { throw new Error('interrupted'); }, async version() { return 'test'; } };
  const survivor = {
    async run(workspace) {
      await failedBuildFinished;
      await access(workspace);
      throw new Error('survivor reached the model');
    },
    async version() { return 'test'; },
  };
  const survivorBuild = buildDataset({ corpusPath: corpus, outputRoot: path.join(root, 'datasets'), workRoot, runner: survivor, options: { resume: false } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(buildDataset({ corpusPath: corpus, outputRoot: path.join(root, 'datasets'), workRoot, runner: failing, options: { resume: false } }), /interrupted/);
  releaseSurvivor();
  await assert.rejects(survivorBuild, /survivor reached the model/);
});

test('estimates remaining Copilot calls from inventoried and completed sections', () => {
  const sections = new Map([
    ['a', { chars: 1000, calls: 0, items: undefined, completed: false }],
    ['b', { chars: 1000, calls: 0, items: undefined, completed: false }],
  ]);
  assert.equal(estimateDatasetCalls({ concurrency: 2, sections }).total, undefined);
  Object.assign(sections.get('a'), { calls: 1, items: 10 });
  assert.equal(estimateDatasetCalls({ concurrency: 2, sections }).total, undefined, 'waits for a round of calls');
  sections.get('b').calls = 1;
  // Prior of one call per item: each section predicts 3 + 10 = 13 calls, with b's size extrapolated from a.
  assert.deepEqual(estimateDatasetCalls({ concurrency: 2, sections }), { done: 2, total: 26 });
  sections.get('a').questions = 5;
  // Generated questions refine the rate before any section finishes: a predicts 3 + 5 × 4 = 23 calls, and b uses 2 calls per item.
  assert.deepEqual(estimateDatasetCalls({ concurrency: 2, sections }), { done: 2, total: 46 });
  Object.assign(sections.get('a'), { calls: 23, completed: true });
  // a learned 2 calls per item, so b predicts 3 + 20 = 23 calls.
  assert.deepEqual(estimateDatasetCalls({ concurrency: 2, sections }), { done: 24, total: 46 });
});

test('finishes admitted sections before starting queued ones', async () => {
  const corpus = path.join(root, 'corpus');
  await mkdir(corpus, { recursive: true });
  await writeFile(path.join(corpus, 'alpha.md'), '# Alpha\n\nAlpha limit is one.\n');
  await writeFile(path.join(corpus, 'beta.md'), '# Beta\n\nBeta limit is two.\n');
  const order = [];
  const runner = {
    async run(_workspace, prompt) {
      const name = prompt.includes('Alpha limit') || prompt.includes('alpha') ? 'alpha' : 'beta';
      order.push(name);
      await new Promise((resolve) => setImmediate(resolve));
      if (prompt.includes('Inventory every independently testable')) {
        const existing = JSON.parse(prompt.split('EXISTING ITEMS:\n')[1].split('\nSOURCE SECTION:')[0]);
        if (existing.length) return { answer: JSON.stringify({ classification: 'non_informational', reason: 'Complete.', items: [] }) };
        const title = name === 'alpha' ? 'Alpha' : 'Beta';
        const value = name === 'alpha' ? 'one' : 'two';
        return { answer: JSON.stringify({ classification: 'informational', reason: 'A fact.', items: [{ kind: 'fact', statement: `${title} limit is ${value}.`, importance: 'high', importanceReason: 'Limit.', quote: `${title} limit is ${value}.` }] }) };
      }
      if (prompt.includes('Generate focused')) {
        const [item] = JSON.parse(prompt.split('KNOWLEDGE INVENTORY:\n')[1]);
        return { answer: JSON.stringify({ questions: [{ question: `What is the ${name} limit?`, type: 'fact', difficulty: 'easy', rubric: [{ criterion: 'States the limit.', weight: 1, knowledgeItemIds: [item.knowledgeId] }] }] }) };
      }
      if (prompt.includes('Use only this complete source')) return { answer: `${name} answer` };
      if (prompt.includes('Calibrate this question')) return { answer: calibration() };
      throw new Error('Unexpected prompt');
    },
    async version() { return 'test'; },
  };
  await buildDataset({ corpusPath: corpus, outputRoot: path.join(root, 'datasets'), workRoot: path.join(root, 'work'), runner, options: { concurrency: 1, resume: false } });
  const firstBeta = order.indexOf('beta');
  assert.ok(firstBeta > 0);
  assert.ok(order.slice(firstBeta).every((name) => name === 'beta'), `sections interleaved: ${order.join(',')}`);
});
