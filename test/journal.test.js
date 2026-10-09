import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';

import { operationId, OperationJournal, releaseAllJournals } from '../src/journal.js';

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

const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const setOwner = (journal, jobId, pid) => journal.database.prepare('UPDATE jobs SET owner_pid = ? WHERE job_id = ?').run(pid, jobId);

async function openStarted(options = {}) {
  const journal = await OperationJournal.open(`${root}/state.sqlite`, options);
  const id = operationId('dataset', { corpus: 'revision' });
  journal.startOperation({ operationId: id, kind: 'dataset', inputs: { corpus: 'revision' } });
  return { journal, id };
}

test('executeJob runs under a lease, stores the output, and reuses it afterwards', async () => {
  const { journal, id } = await openStarted();
  const job = journal.ensureJob({ operationId: id, stage: 'section', entityId: 'one', label: 'doc.md › One', inputs: { a: 1 } });
  assert.equal(job.label, 'doc.md › One');
  const first = await journal.executeJob(job, async ({ attempt }) => ({ attempt }));
  assert.deepEqual(first, { output: { attempt: 1 }, reused: false, job: journal.getJob(job.jobId) });
  const second = await journal.executeJob(journal.getJob(job.jobId), async () => { throw new Error('must not run'); });
  assert.equal(second.reused, true);
  assert.deepEqual(second.output, { attempt: 1 });
  journal.close();
});

test('executeJob records failures with structured details and clears the lease', async () => {
  const { journal, id } = await openStarted();
  const job = journal.ensureJob({ operationId: id, stage: 'section', entityId: 'one', inputs: {} });
  const failure = Object.assign(new Error('did not converge'), { details: { passes: [1, 2, 3] } });
  await assert.rejects(journal.executeJob(job, async () => { throw failure; }), /did not converge/);
  const failed = journal.getJob(job.jobId);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.details, { passes: [1, 2, 3] });
  assert.equal(failed.leaseOwner, null);
  const retry = await journal.executeJob(failed, async ({ attempt }) => attempt);
  assert.equal(retry.output, 2);
  assert.equal(journal.getJob(job.jobId).details, undefined);
  journal.close();
});

test('a job leased by a dead process is taken over at once, a live owner is not', async () => {
  const { journal, id } = await openStarted({ leaseMs: 10 * 60 * 1000 });
  const job = journal.ensureJob({ operationId: id, stage: 'section', entityId: 'one', inputs: {} });
  assert.ok(journal.claimJob(job.jobId, 'worker-a'));
  setOwner(journal, job.jobId, process.ppid);
  assert.equal(journal.claimJob(job.jobId, 'worker-b'), undefined);
  assert.equal(journal.isJobStale(journal.getJob(job.jobId)), false);
  setOwner(journal, job.jobId, deadPid());
  assert.equal(journal.isJobStale(journal.getJob(job.jobId)), true);
  const taken = journal.claimJob(job.jobId, 'worker-b');
  assert.equal(taken.leaseOwner, 'worker-b');
  assert.equal(taken.attempts, 2);
  journal.close();
});

test('executeJob waits for a live lease and returns the output the other process produced', async () => {
  const { journal, id } = await openStarted({ leaseMs: 10 * 60 * 1000 });
  const job = journal.ensureJob({ operationId: id, stage: 'section', entityId: 'one', label: 'doc.md › One', inputs: {} });
  journal.claimJob(job.jobId, 'other-process');
  setOwner(journal, job.jobId, process.ppid);
  const waits = [];
  const pending = journal.executeJob(job, async () => { throw new Error('must not run'); }, { pollMs: 5, onWait: (wait) => waits.push(wait) });
  await new Promise((resolve) => setTimeout(resolve, 40));
  journal.database.prepare("UPDATE jobs SET status = 'completed', output_json = ?, lease_owner = NULL, owner_pid = NULL WHERE job_id = ?").run('{"done":true}', job.jobId);
  const result = await pending;
  assert.equal(result.reused, true);
  assert.deepEqual(result.output, { done: true });
  assert.ok(waits.length >= 2);
  assert.equal(waits[0].job.label, 'doc.md › One');
  assert.equal(waits[0].ownerPid, process.ppid);
  journal.close();
});

test('executeJob stops waiting on a lease that never frees', async () => {
  const { journal, id } = await openStarted({ leaseMs: 10 * 60 * 1000 });
  const job = journal.ensureJob({ operationId: id, stage: 'section', entityId: 'one', inputs: {} });
  journal.claimJob(job.jobId, 'other-process');
  setOwner(journal, job.jobId, process.ppid);
  await assert.rejects(journal.executeJob(job, async () => 1, { pollMs: 5, maxWaitMs: 30 }), (error) => error.code === 'LEASE_WAIT_TIMEOUT' && /operation recover/.test(error.remedy));
  journal.close();
});

test('completed jobs are reused across operations that share a cache scope and nowhere else', async () => {
  const journal = await OperationJournal.open(`${root}/state.sqlite`);
  const start = (name, cacheScope) => { const id = operationId('dataset', { name }); journal.startOperation({ operationId: id, kind: 'dataset', inputs: { name }, cacheScope }); return id; };
  const first = start('first', { model: 'a' });
  const job = journal.ensureJob({ operationId: first, stage: 'section', entityId: 'one', inputs: { text: 'x' } });
  await journal.executeJob(job, async () => ({ items: 3 }));

  const sameScope = journal.ensureJob({ operationId: start('second', { model: 'a' }), stage: 'section', entityId: 'one', inputs: { text: 'x' } });
  assert.equal(sameScope.status, 'completed');
  assert.deepEqual(sameScope.output, { items: 3 });
  assert.equal(sameScope.reusedFrom, job.jobId);
  assert.equal(journal.ensureJob({ operationId: start('third', { model: 'b' }), stage: 'section', entityId: 'one', inputs: { text: 'x' } }).status, 'pending');
  assert.equal(journal.ensureJob({ operationId: start('fourth'), stage: 'section', entityId: 'one', inputs: { text: 'x' } }).status, 'pending');
  assert.equal(journal.ensureJob({ operationId: start('fifth', { model: 'a' }), stage: 'section', entityId: 'one', inputs: { text: 'changed' } }).status, 'pending');
  journal.close();
});

test('only one live process may run an operation; dead or silent owners are replaced', async () => {
  let now = 1_000;
  const { journal, id } = await openStarted({ clock: () => now, leaseMs: 100 });
  const setLock = (pid, heartbeat) => journal.database.prepare('UPDATE operations SET lock_pid = ?, lock_host = ?, lock_heartbeat_at = ? WHERE operation_id = ?').run(pid, os.hostname(), heartbeat, id);
  setLock(process.ppid, now);
  assert.throws(() => journal.acquireOperationLock(id), (error) => error.code === 'OPERATION_LOCKED' && error.exitCode === 4 && error.details.pid === process.ppid);
  assert.equal(journal.operationHealth(journal.getOperation(id), { pending: 1, running: 0, completed: 0, failed: 0 }), 'running');
  now += 500;
  assert.equal(journal.operationHealth(journal.getOperation(id), { pending: 1, running: 0, completed: 0, failed: 0 }), 'interrupted');
  journal.acquireOperationLock(id);
  assert.equal(journal.getOperation(id).lockPid, process.pid);
  setLock(deadPid(), now);
  journal.acquireOperationLock(id);
  assert.equal(journal.getOperation(id).lockPid, process.pid);
  journal.failOperation(id, new Error('boom'));
  assert.equal(journal.getOperation(id).status, 'failed');
  journal.close();
});

test('an operation whose owner died or never started is reported as interrupted even with no unfinished jobs', async () => {
  let now = 1_000_000;
  const { journal, id } = await openStarted({ clock: () => now, leaseMs: 100 });
  const empty = { pending: 0, running: 0, completed: 3, failed: 0 };
  assert.equal(journal.operationHealth(journal.getOperation(id), empty), 'running');
  now += 11_000;
  assert.equal(journal.operationHealth(journal.getOperation(id), empty), 'interrupted');
  journal.database.prepare('UPDATE operations SET lock_pid = ?, lock_host = ?, lock_heartbeat_at = ? WHERE operation_id = ?').run(deadPid(), os.hostname(), now, id);
  assert.equal(journal.operationHealth(journal.getOperation(id), empty), 'interrupted');
  journal.close();
});

test('closing a journal hands claimed jobs back and releases the operation lock', async () => {
  const { journal, id } = await openStarted();
  journal.acquireOperationLock(id);
  const job = journal.ensureJob({ operationId: id, stage: 'section', entityId: 'one', inputs: {} });
  journal.claimJob(job.jobId, 'worker');
  journal.close();
  const reopened = await OperationJournal.open(`${root}/state.sqlite`);
  assert.equal(reopened.getJob(job.jobId).status, 'pending');
  assert.equal(reopened.getJob(job.jobId).ownerPid, null);
  assert.equal(reopened.getOperation(id).lockPid, null);
  assert.equal(reopened.getJob(job.jobId).attempts, 1);
  reopened.close();
});

test('releaseAllJournals frees work held by every open journal, as a signal handler would', async () => {
  const { journal, id } = await openStarted();
  const job = journal.ensureJob({ operationId: id, stage: 'section', entityId: 'one', inputs: {} });
  journal.claimJob(job.jobId, 'worker');
  releaseAllJournals();
  assert.equal(journal.getJob(job.jobId).status, 'pending');
  journal.close();
});

test('recoverStaleJobs frees only abandoned leases', async () => {
  const { journal, id } = await openStarted({ leaseMs: 10 * 60 * 1000 });
  const dead = journal.ensureJob({ operationId: id, stage: 'section', entityId: 'dead', inputs: {} });
  const live = journal.ensureJob({ operationId: id, stage: 'section', entityId: 'live', inputs: {} });
  journal.claimJob(dead.jobId, 'a');
  journal.claimJob(live.jobId, 'b');
  setOwner(journal, dead.jobId, deadPid());
  setOwner(journal, live.jobId, process.ppid);
  assert.equal(journal.recoverStaleJobs(id), 1);
  assert.equal(journal.getJob(dead.jobId).status, 'pending');
  assert.equal(journal.getJob(live.jobId).status, 'running');
  journal.workers.clear();
  journal.close();
});

test('opens a journal created by an older version and adds the new columns', async () => {
  await mkdir(root, { recursive: true });
  const legacy = new DatabaseSync(`${root}/state.sqlite`);
  legacy.exec(`
    CREATE TABLE operations (operation_id TEXT PRIMARY KEY, kind TEXT NOT NULL, input_hash TEXT NOT NULL, config_json TEXT NOT NULL, status TEXT NOT NULL, publication_path TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE jobs (job_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, stage TEXT NOT NULL, entity_id TEXT NOT NULL, input_hash TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_expires_at INTEGER, output_json TEXT, output_hash TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(operation_id, stage, entity_id, input_hash));
    INSERT INTO operations VALUES ('dataset_old', 'dataset', 'h', '{}', 'running', NULL, 1, 1);
    INSERT INTO jobs (job_id, operation_id, stage, entity_id, input_hash, status, created_at, updated_at) VALUES ('job_old', 'dataset_old', 'section', 'one', 'h', 'pending', 1, 1);
  `);
  legacy.close();
  const journal = await OperationJournal.open(`${root}/state.sqlite`);
  assert.equal(journal.getJob('job_old').label, null);
  assert.equal(journal.getOperation('dataset_old').lockPid, null);
  const result = await journal.executeJob(journal.getJob('job_old'), async () => 'ok');
  assert.equal(result.output, 'ok');
  journal.close();
});
