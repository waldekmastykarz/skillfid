import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import path from 'node:path';

import { buildDataset, loadDataset } from '../src/dataset.js';
import { OperationJournal } from '../src/journal.js';

const root = '.work/js-tests/dataset-resilience';
afterEach(async () => rm(root, { recursive: true, force: true }));

const calibration = (count) => JSON.stringify({ criterionResults: Array.from({ length: count }, (_, index) => ({ criterionIndex: index, score: 1, rationale: 'Complete.' })), unsupportedClaims: [], verification: { answerable: true, referenceSupported: true, criteriaSupported: true, mappedItemsRequired: true, requiresCorpusKnowledge: true, unambiguous: true, answerLeakage: false, reason: 'Valid.' }, integrity: { directlyEntailed: true, contradictionChecked: true, qualificationsIncluded: true, authorityResolved: true, proxyAnswer: false, rationale: 'Checked.' } });
const none = JSON.stringify({ classification: 'non_informational', reason: 'Complete.', items: [] });
const item = (statement, quote, importance = 'high') => ({ kind: 'fact', statement, importance, importanceReason: 'Matters.', quote });
const inventory = (...items) => JSON.stringify({ classification: 'informational', reason: 'Facts.', items });
const sectionText = (prompt) => prompt.split('SOURCE SECTION:\n')[1];
const existingItems = (prompt) => JSON.parse(prompt.split('EXISTING ITEMS:\n')[1].split('\nSOURCE SECTION:')[0]);

// Answers every dataset prompt; `inventoryAnswer(prompt, calls)` decides how each section's inventory behaves.
function fakeRunner({ inventoryAnswer, onCall = () => {} }) {
  const inventoryCalls = new Map();
  return {
    inventoryCalls,
    async run(_workspace, prompt) {
      onCall(prompt);
      if (prompt.includes('Inventory every independently testable')) {
        const key = sectionText(prompt).slice(0, 40);
        const calls = (inventoryCalls.get(key) ?? 0) + 1;
        inventoryCalls.set(key, calls);
        return { answer: inventoryAnswer(prompt, calls) };
      }
      if (prompt.includes('Generate focused')) {
        const items = JSON.parse(prompt.split('KNOWLEDGE INVENTORY:\n')[1].split('\n\nThe previous')[0]);
        const questions = [];
        for (let index = 0; index < items.length; index += 6) {
          const group = items.slice(index, index + 6);
          questions.push({ question: `What do we know about ${group[0].statement.split(' ').slice(0, 3).join(' ')}?`, type: 'fact', difficulty: 'easy', rubric: group.map((entry) => ({ criterion: entry.statement, weight: 1 / group.length, knowledgeItemIds: [entry.knowledgeId] })) });
        }
        return { answer: JSON.stringify({ questions }) };
      }
      if (prompt.includes('Use only this complete source')) return { answer: 'An answer.' };
      if (prompt.includes('Calibrate this question')) return { answer: calibration(JSON.parse(prompt.split('INPUT:\n')[1]).rubric.length) };
      throw new Error(`Unexpected prompt: ${prompt.slice(0, 80)}`);
    },
    async version() { return 'test'; },
  };
}

async function writeCorpus(files) {
  const corpus = path.join(root, 'corpus');
  await mkdir(corpus, { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(corpus, name), content);
  return corpus;
}

const build = (corpus, runner, options = {}, progress) => buildDataset({ corpusPath: corpus, outputRoot: path.join(root, 'datasets'), workRoot: path.join(root, 'work'), runner, options, progress });

// Beta keeps discovering new facts for `extraPasses` residual passes; Alpha settles at once.
function densenessRunner(extraPasses, counters = {}) {
  let betaResidual = 0;
  return fakeRunner({
    onCall: (prompt) => { if (prompt.includes('Alpha limit')) counters.alpha = (counters.alpha ?? 0) + 1; },
    inventoryAnswer: (prompt) => {
      const existing = existingItems(prompt);
      if (prompt.includes('Alpha limit')) return existing.length ? none : inventory(item('Alpha limit is one.', 'Alpha limit is one.'));
      if (!existing.length) return inventory(item('Beta limit is two.', 'Beta limit is two.'));
      betaResidual += 1;
      return betaResidual <= extraPasses ? inventory(item(`Gadget${betaResidual} widget${betaResidual} sprocket${betaResidual}.`, 'Beta limit is two.')) : none;
    },
  });
}

test('one section that does not settle fails the build clearly, keeps the other sections, and resumes with a bigger budget', async () => {
  const corpus = await writeCorpus({ 'alpha.md': '# Alpha\n\nAlpha limit is one.\n', 'beta.md': '# Beta\n\nBeta limit is two.\n' });
  const counters = {};
  const events = [];
  const runner = densenessRunner(5, counters);
  await assert.rejects(build(corpus, runner, { maxResidualPasses: 3, escalate: false }, (event) => events.push(event)), (error) => {
    assert.equal(error.code, 'SECTIONS_FAILED');
    assert.equal(error.exitCode, 3);
    assert.match(error.message, /1 of 2 sections failed; the other 1 are saved/);
    assert.match(error.message, /beta\.md › Beta \(lines 1–3\)/);
    assert.match(error.message, /did not converge/);
    assert.match(error.message, /Failure details: /);
    assert.equal(error.details.failures[0].details.history.at(-1).added, 1);
    return true;
  });
  assert.ok(events.some((event) => event.type === 'error' && /Section failed: beta\.md › Beta/.test(event.message)));
  const failuresPath = path.join(root, 'work', 'failures');
  const reportFile = (await readdir(failuresPath)).find((name) => name.endsWith('.json'));
  const report = JSON.parse(await readFile(path.join(failuresPath, reportFile), 'utf8'));
  assert.equal(report.failures[0].label, 'beta.md › Beta (lines 1–3)');

  // The failed section keeps every prompt and answer, so its failure can be diagnosed after the run.
  const transcriptLines = (await readFile(report.failures[0].transcriptPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const [header, ...calls] = transcriptLines;
  assert.equal(header.label, 'beta.md › Beta (lines 1–3)');
  assert.match(header.error, /did not converge/);
  assert.equal(header.calls, calls.length);
  assert.ok(calls.length >= 4);
  assert.ok(calls.every((call) => call.role === 'subject' && call.prompt.includes('Beta limit is two.')));
  assert.ok(calls.every((call) => typeof call.answer === 'string'));
  const alphaCalls = counters.alpha;

  // Raising the budget is not a new build: the finished alpha section is reused and only beta reruns.
  const dataset = await loadDataset(await build(corpus, densenessRunner(5, counters), { maxResidualPasses: 6, escalate: false }));
  assert.equal(dataset.questions.length >= 2, true);
  assert.equal(counters.alpha, alphaCalls);
  const journal = await OperationJournal.open(path.join(root, 'work', 'operations.sqlite'), { readOnly: true });
  const operations = journal.listOperations();
  assert.equal(operations.length, 1);
  assert.equal(operations[0].status, 'completed');
  journal.close();
});

test('a dense section automatically gets a larger pass budget before failing', async () => {
  const corpus = await writeCorpus({ 'beta.md': '# Beta\n\nBeta limit is two.\n' });
  const events = [];
  const dataset = await loadDataset(await build(corpus, densenessRunner(5), { maxResidualPasses: 3 }, (event) => events.push(event)));
  assert.equal(dataset.knowledge.length, 6);
  assert.ok(events.some((event) => event.type === 'warning' && /did not settle in 3 passes; extending to 6/.test(event.message)));
});

test('a section that never settles is split in half and each part is inventoried on its own', async () => {
  const alphaParagraph = `ALPHA-MARK ${'Alpha facts are listed here. '.repeat(10)}Alpha limit is one.`;
  const betaParagraph = `BETA-MARK ${'Beta facts are listed here. '.repeat(10)}Beta limit is two.`;
  const corpus = await writeCorpus({ 'big.md': `# Big\n\n${alphaParagraph}\n\n${betaParagraph}\n` });
  let fresh = 0;
  const runner = fakeRunner({
    inventoryAnswer: (prompt) => {
      const text = sectionText(prompt);
      const both = text.includes('ALPHA-MARK') && text.includes('BETA-MARK');
      const existing = existingItems(prompt);
      if (!existing.length) return inventory(...[text.includes('ALPHA-MARK') && item('Alpha limit is one.', 'Alpha limit is one.'), text.includes('BETA-MARK') && item('Beta limit is two.', 'Beta limit is two.')].filter(Boolean));
      if (!both) return none;
      fresh += 1;
      return inventory(item(`Noise${fresh} filler${fresh} entry${fresh}.`, 'Alpha limit is one.'));
    },
  });
  const events = [];
  const datasetPath = await build(corpus, runner, { maxResidualPasses: 1 }, (event) => events.push(event));
  const dataset = await loadDataset(datasetPath);
  assert.deepEqual(dataset.knowledge.map((entry) => entry.statement).sort(), ['Alpha limit is one.', 'Beta limit is two.']);
  assert.ok(dataset.knowledge.every((entry) => entry.sectionId === dataset.knowledge[0].sectionId));
  assert.ok(events.some((event) => event.type === 'warning' && /splitting it into two parts/.test(event.message)));
  const audit = JSON.parse(await readFile(path.join(datasetPath, 'audit.json'), 'utf8'));
  assert.equal(audit.sections[0].split, true);
  assert.equal(JSON.parse(await readFile(path.join(datasetPath, 'coverage.json'), 'utf8')).sections, 1);
  const last = events.filter((event) => event.progress?.total).at(-1).progress;
  assert.deepEqual([last.done, last.total], [2, 2]);
});

test('--fresh regenerates sections instead of reusing cached jobs from an earlier operation', async () => {
  const corpus = await writeCorpus({ 'beta.md': '# Beta\n\nBeta limit is two.\n' });
  let calls = 0;
  const runner = fakeRunner({ onCall: () => { calls += 1; }, inventoryAnswer: (prompt) => existingItems(prompt).length ? none : inventory(item('Beta limit is two.', 'Beta limit is two.')) });
  await build(corpus, runner);
  const first = calls;
  await build(corpus, runner, { resume: false });
  assert.equal(calls, first * 2);
  await build(corpus, runner, { resume: true });
  assert.equal(calls, first * 2);
});

test('restating an existing item is not new knowledge and does not block convergence', async () => {
  const corpus = await writeCorpus({ 'beta.md': '# Beta\n\nBeta limit is two.\n' });
  let residual = 0;
  const runner = fakeRunner({
    inventoryAnswer: (prompt) => {
      if (!existingItems(prompt).length) return inventory(item('The Beta limit is two.', 'Beta limit is two.'));
      residual += 1;
      return inventory(item('Beta limit is exactly two.', 'Beta limit is two.'));
    },
  });
  const dataset = await loadDataset(await build(corpus, runner, { maxResidualPasses: 1, escalate: false }));
  assert.equal(dataset.knowledge.length, 1);
  assert.equal(residual, 1);
});

test('low-importance leftovers are accepted as diminishing returns after the second pass', async () => {
  const corpus = await writeCorpus({ 'beta.md': '# Beta\n\nBeta limit is two.\n' });
  let residual = 0;
  const runner = fakeRunner({
    inventoryAnswer: (prompt) => {
      if (!existingItems(prompt).length) return inventory(item('Beta limit is two.', 'Beta limit is two.'));
      residual += 1;
      return inventory(item(`Trivia${residual} detail${residual} note${residual}.`, 'Beta limit is two.', residual === 1 ? 'high' : 'low'));
    },
  });
  const dataset = await loadDataset(await build(corpus, runner, { maxResidualPasses: 3, escalate: false }));
  // Two residual passes plus one completeness audit, each accepting one more low-importance leftover.
  assert.equal(dataset.knowledge.length, 4);
  assert.equal(residual, 3);
});

test('importance profiles limit coverage to the selected tiers and record them', async () => {
  const corpus = await writeCorpus({ 'beta.md': '# Beta\n\nBeta limit is two. A footnote mentions teal.\n' });
  const runner = fakeRunner({
    inventoryAnswer: (prompt) => existingItems(prompt).length ? none : inventory(item('Beta limit is two.', 'Beta limit is two.'), item('A footnote mentions teal.', 'A footnote mentions teal.', 'low')),
  });
  const datasetPath = await build(corpus, runner, { importance: ['high', 'medium'] });
  const dataset = await loadDataset(datasetPath);
  assert.deepEqual(dataset.knowledge.map((entry) => entry.statement), ['Beta limit is two.']);
  const coverage = JSON.parse(await readFile(path.join(datasetPath, 'coverage.json'), 'utf8'));
  assert.deepEqual(coverage.importanceTiers, ['high', 'medium']);
  assert.equal(coverage.excludedItems, 1);
  await assert.rejects(build(corpus, runner, { importance: ['urgent'], resume: false }), /subset of high, medium, low/);
});

test('progress events name the stage mix, counts and human labels instead of bare updates', async () => {
  const corpus = await writeCorpus({ 'alpha.md': '# Alpha\n\nAlpha limit is one.\n', 'beta.md': '# Beta\n\nBeta limit is two.\n' });
  const events = [];
  const runner = fakeRunner({ inventoryAnswer: (prompt) => existingItems(prompt).length ? none : inventory(item(sectionText(prompt).includes('Alpha') ? 'Alpha limit is one.' : 'Beta limit is two.', sectionText(prompt).includes('Alpha') ? 'Alpha limit is one.' : 'Beta limit is two.')) });
  await build(corpus, runner, {}, (event) => events.push(event));
  const withMetrics = events.filter((event) => event.metrics);
  assert.ok(withMetrics.length > 5);
  assert.ok(withMetrics.some((event) => /inventory:\d/.test(event.metrics.stages ?? '')));
  assert.ok(withMetrics.some((event) => /calibration:\d/.test(event.metrics.stages ?? '')));
  assert.ok(withMetrics.some((event) => event.metrics.calls > 0));
  assert.equal(withMetrics.at(-1).metrics.sections, '2/2');
  assert.ok(events.some((event) => /alpha\.md › Alpha \(lines 1–3\)/.test(event.current ?? '')));
});

test('the three independent judgments run in parallel', async () => {
  const corpus = await writeCorpus({ 'beta.md': '# Beta\n\nBeta limit is two.\n' });
  let active = 0;
  let peak = 0;
  const base = fakeRunner({ inventoryAnswer: (prompt) => existingItems(prompt).length ? none : inventory(item('Beta limit is two.', 'Beta limit is two.')) });
  const runner = {
    async run(workspace, prompt) {
      const judging = prompt.includes('Calibrate this question');
      if (judging) { active += 1; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 20)); }
      try { return await base.run(workspace, prompt); }
      finally { if (judging) active -= 1; }
    },
    version: base.version,
  };
  await build(corpus, runner);
  assert.equal(peak, 3);
});

test('adjacent small sections are merged into one unit per chapter and a heading-only section joins what follows', async () => {
  const corpus = await writeCorpus({ 'doc.md': '# Part\n\n## Chapter\n\nIntro text.\n\n### A\n\nAlpha limit is one.\n\n### B\n\nBeta limit is two.\n' });
  const prompts = [];
  const runner = fakeRunner({
    onCall: (prompt) => { if (prompt.includes('Inventory every')) prompts.push(sectionText(prompt)); },
    inventoryAnswer: (prompt) => existingItems(prompt).length ? none : inventory(item('Alpha limit is one.', 'Alpha limit is one.'), item('Beta limit is two.', 'Beta limit is two.')),
  });
  await build(corpus, runner);
  assert.equal(prompts.length, 2);
  assert.ok(prompts[0].includes('Alpha limit is one.') && prompts[0].includes('Beta limit is two.') && prompts[0].includes('# Part'));
});
