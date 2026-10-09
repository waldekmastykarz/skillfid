import assert from 'node:assert/strict';
import { test } from 'node:test';

import { auditInventory, ConvergenceError, convergeInventory, isDiminishing, jaccard, novelItems, statementTokens } from '../src/inventory-passes.js';

let counter = 0;
function entry(statement, { start = 0, end = 20, importance = 'high' } = {}) {
  counter += 1;
  const evidenceId = `ev_${counter}`;
  return { item: { knowledgeId: `ki_${counter}`, statement, importance, evidenceIds: [evidenceId] }, evidence: { evidenceId, start, end } };
}
const result = (...entries) => ({ items: entries.map(({ item }) => item), evidence: entries.map(({ evidence }) => evidence), reason: 'because' });
const reporter = () => { const log = []; return { log, stage: (text) => log.push(['stage', text]), warn: (text) => log.push(['warn', text]), results: (value) => log.push(['results', value]) }; };

test('similarity helpers compare word sets', () => {
  assert.deepEqual([...statementTokens('The Limit, is 2 GB!')].sort(), ['2', 'gb', 'is', 'limit', 'the']);
  assert.equal(jaccard(statementTokens('a b c'), statementTokens('a b c')), 1);
  assert.equal(jaccard(statementTokens('a b'), statementTokens('c d')), 0);
});

test('a restatement of an item on the same passage is not new, but a different fact on that passage is', () => {
  const known = entry('The upload limit is two gigabytes.', { start: 0, end: 40 });
  const restated = entry('Upload limit is two gigabytes', { start: 0, end: 40 });
  const differentFact = entry('Uploads above the limit are rejected before transfer begins.', { start: 0, end: 40 });
  const sameWordsElsewhere = entry('The upload limit is two gigabytes.', { start: 500, end: 540 });
  const sameId = { item: { ...known.item }, evidence: known.evidence };
  const candidates = result(restated, differentFact, sameWordsElsewhere, sameId);
  const { additions, duplicates } = novelItems({ items: [known.item], evidence: [known.evidence], candidates: candidates.items, candidateEvidence: candidates.evidence });
  assert.deepEqual(additions.map((item) => item.statement), ['Uploads above the limit are rejected before transfer begins.']);
  assert.equal(duplicates.length, 3);
});

test('candidates repeated within one pass are only added once', () => {
  const first = entry('Retries stop after five attempts.', { start: 0, end: 30 });
  const again = entry('Retries stop after five attempts', { start: 0, end: 30 });
  const { additions } = novelItems({ items: [], evidence: [], candidates: [first.item, again.item], candidateEvidence: [first.evidence, again.evidence] });
  assert.equal(additions.length, 1);
});

test('only low-importance additions from the second pass on count as diminishing returns', () => {
  const low = entry('x', { importance: 'low' }).item;
  const high = entry('y').item;
  assert.equal(isDiminishing([low], 1), false);
  assert.equal(isDiminishing([low], 2), true);
  assert.equal(isDiminishing([low, high], 3), false);
  assert.equal(isDiminishing([], 3), false);
});

const settings = (overrides = {}) => ({ cleanResidualPasses: 1, maxResidualPasses: 2, maxAuditPasses: 2, escalate: true, ...overrides });
const distinct = (n) => entry(`Fact${n} about topic${n} and aspect${n}.`, { start: n * 100, end: n * 100 + 50 });

test('convergence ends after a clean pass and reports what each pass found', async () => {
  const calls = [];
  const initial = distinct(1);
  const extra = distinct(2);
  const answers = [result(initial), result(extra), result()];
  const out = await convergeInventory({ extract: async (items) => { calls.push(items.length); return answers.shift(); }, label: 'doc.md › A', settings: settings(), reporter: reporter() });
  assert.deepEqual(calls, [0, 1, 2]);
  assert.equal(out.items.length, 2);
  assert.equal(out.recovered, true);
  assert.deepEqual(out.history.map((pass) => [pass.kind, pass.added]), [['initial', 1], ['residual', 1], ['residual', 0]]);
});

test('a section that keeps finding facts gets a larger budget once, then fails with the pass history', async () => {
  let next = 10;
  const log = reporter();
  const extract = async (items) => (items.length === 0 ? result(distinct(next++)) : result(distinct(next++)));
  await assert.rejects(convergeInventory({ extract, label: 'doc.md › Dense', settings: settings(), reporter: log }), (error) => {
    assert.ok(error instanceof ConvergenceError);
    assert.equal(error.code, 'INVENTORY_NOT_CONVERGED');
    assert.equal(error.exitCode, 3);
    assert.match(error.message, /Inventory did not converge for doc\.md › Dense after 4 passes/);
    assert.equal(error.details.history.filter((pass) => pass.kind === 'residual').length, 4);
    assert.match(error.remedy, /max-residual-passes/);
    return true;
  });
  assert.deepEqual(log.log.filter(([kind]) => kind === 'warn'), [['warn', 'doc.md › Dense did not settle in 2 passes; extending to 4']]);
  await assert.rejects(convergeInventory({ extract, label: 'x', settings: settings({ escalate: false }), reporter: reporter() }), /after 2 passes/);
});

test('the completeness audit only runs after the residual passes recovered something', async () => {
  const base = result(distinct(30));
  let audits = 0;
  const skipped = await auditInventory({ extract: async () => { audits += 1; return result(); }, inventory: { items: base.items, evidence: base.evidence, recovered: false, lastResidual: { reason: 'ok' }, history: [] }, label: 'x', settings: settings(), reporter: reporter() });
  assert.equal(audits, 0);
  assert.equal(skipped.audit.reason, 'ok');

  const missing = distinct(31);
  const answers = [result(missing), result()];
  const audited = await auditInventory({ extract: async () => answers.shift(), inventory: { items: base.items, evidence: base.evidence, recovered: true, lastResidual: { reason: 'r' }, history: [] }, label: 'x', settings: settings(), reporter: reporter() });
  assert.equal(audited.items.length, 2);
  assert.deepEqual(audited.recoveredKnowledgeIds, [missing.item.knowledgeId]);

  let n = 40;
  await assert.rejects(auditInventory({ extract: async () => result(distinct(n++)), inventory: { items: base.items, evidence: base.evidence, recovered: true, lastResidual: { reason: 'r' }, history: [] }, label: 'doc.md › Audit', settings: settings(), reporter: reporter() }), (error) => error.code === 'AUDIT_NOT_CONVERGED' && /Completeness audit did not converge for doc\.md › Audit/.test(error.message));
});
