import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { afterEach, test } from 'node:test';

import { operationId, OperationJournal } from '../src/journal.js';

const root = '.work/js-tests/journal';
afterEach(async () => rm(root, { recursive: true, force: true }));

test('operation identity is stable and input-sensitive', () => {
  assert.equal(operationId('dataset', { model: 'a', corpus: 'x' }), operationId('dataset', { corpus: 'x', model: 'a' }));
  assert.notEqual(operationId('dataset', { model: 'a' }), operationId('dataset', { model: 'b' }));
});

test('persists completed jobs for resume', async () => {
  const filePath = `${root}/state.sqlite`;
  const id = operationId('dataset', { corpus: 'revision' });
  let journal = await OperationJournal.open(filePath);
  journal.startOperation({ operationId: id, kind: 'dataset', inputs: { corpus: 'revision' }, config: { concurrency: 10 } });
  const job = journal.ensureJob({ operationId: id, stage: 'section', entityId: 'one', inputs: { revision: 'a' } });
  const claimed = journal.claimJob(job.jobId, 'worker-a');
  assert.equal(claimed.status, 'running');
  journal.completeJob(job.jobId, 'worker-a', { questions: 2 });
  assert.deepEqual(journal.jobCounts(id), { pending: 0, running: 0, completed: 1, failed: 0 });
  journal.close();

  journal = await OperationJournal.open(filePath);
  assert.deepEqual(journal.getJob(job.jobId).output, { questions: 2 });
  assert.deepEqual(journal.listOperations().map((operation) => operation.operationId), [id]);
  assert.equal(journal.claimJob(job.jobId, 'worker-b'), undefined);
  assert.equal(journal.completeOperation(id, 'datasets/example').publicationPath, 'datasets/example');
  journal.close();

  journal = await OperationJournal.open(filePath, { readOnly: true });
  assert.deepEqual(journal.listOperations().map((operation) => operation.operationId), [id]);
  assert.throws(() => journal.startOperation({ operationId: 'blocked', kind: 'dataset', inputs: {} }), /readonly/i);
  journal.close();
});

test('finds the newest incomplete operation with matching inputs', async () => {
  let now = 1_000;
  const journal = await OperationJournal.open(`${root}/state.sqlite`, { clock: () => now });
  const inputs = { corpus: 'revision' };
  const baseId = operationId('dataset', inputs);
  journal.startOperation({ operationId: baseId, kind: 'dataset', inputs });
  now += 1;
  journal.startOperation({ operationId: `${baseId}_fresh`, kind: 'dataset', inputs, config: { fresh: true } });
  journal.startOperation({ operationId: 'unrelated', kind: 'dataset', inputs: { corpus: 'other' } });

  assert.equal(journal.findResumableOperation('dataset', inputs).operationId, `${baseId}_fresh`);
  journal.completeOperation(`${baseId}_fresh`, 'datasets/example');
  assert.equal(journal.findResumableOperation('dataset', inputs).operationId, baseId);
  journal.close();
});

test('reclaims an expired lease but not an active lease', async () => {
  let now = 1_000;
  const journal = await OperationJournal.open(`${root}/state.sqlite`, { clock: () => now, leaseMs: 100 });
  const id = operationId('evaluation', { dataset: 'one' });
  journal.startOperation({ operationId: id, kind: 'evaluation', inputs: { dataset: 'one' } });
  const job = journal.ensureJob({ operationId: id, stage: 'question', entityId: 'q1', inputs: { testId: 'q1' } });
  assert.ok(journal.claimJob(job.jobId, 'worker-a'));
  assert.equal(journal.claimJob(job.jobId, 'worker-b'), undefined);
  now = 1_101;
  const reclaimed = journal.claimJob(job.jobId, 'worker-b');
  assert.equal(reclaimed.leaseOwner, 'worker-b');
  assert.equal(reclaimed.attempts, 2);
  assert.throws(() => journal.completeJob(job.jobId, 'worker-a', {}), /does not own/);
  journal.failJob(job.jobId, 'worker-b', new Error('transient failure'));
  assert.equal(journal.getJob(job.jobId).error, 'transient failure');
  journal.close();
});

test('does not reuse a job when semantic inputs change', async () => {
  const journal = await OperationJournal.open(`${root}/state.sqlite`);
  const id = operationId('dataset', { corpus: 'revision' });
  journal.startOperation({ operationId: id, kind: 'dataset', inputs: { corpus: 'revision' } });
  const first = journal.ensureJob({ operationId: id, stage: 'section', entityId: 'one', inputs: { promptVersion: 1 } });
  const second = journal.ensureJob({ operationId: id, stage: 'section', entityId: 'one', inputs: { promptVersion: 2 } });
  assert.notEqual(first.jobId, second.jobId);
  assert.equal(journal.listJobs(id).length, 2);
  journal.close();
});
