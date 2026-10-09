import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, test } from 'node:test';

import { OperationJournal } from '../src/journal.js';
import { readOperations } from '../src/operations.js';

const root = '.work/js-tests/shutdown';
afterEach(async () => rm(root, { recursive: true, force: true }));

const journalUrl = pathToFileURL(path.resolve('src/journal.js')).href;
const cliUrl = pathToFileURL(path.resolve('src/cli.js')).href;

// A child process that registers an operation, claims two jobs, and then idles like a run in the middle of a build.
const childScript = (withShutdownHandlers) => `
  import { OperationJournal, operationId } from ${JSON.stringify(journalUrl)};
  ${withShutdownHandlers ? `import { installShutdownHandlers } from ${JSON.stringify(cliUrl)}; installShutdownHandlers({ stderr: { write() {} } });` : ''}
  const journal = await OperationJournal.open(${JSON.stringify(path.resolve(root, 'operations.sqlite'))});
  const id = operationId('dataset', { test: true });
  journal.startOperation({ operationId: id, kind: 'dataset', inputs: { test: true } });
  journal.acquireOperationLock(id);
  for (const name of ['one', 'two', 'three']) {
    const job = journal.ensureJob({ operationId: id, stage: 'section', entityId: name, label: 'doc.md › ' + name, inputs: {} });
    if (name !== 'three') journal.claimJob(job.jobId, 'worker-' + name);
  }
  process.stdout.write('ready\\n');
  setInterval(() => {}, 1000);
`;

function startChild(withShutdownHandlers) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript(withShutdownHandlers)], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('ready')) resolve(); });
    child.once('exit', () => reject(new Error('child exited before it was ready')));
  });
  return { child, exited, ready };
}

test('jobs of a killed run are taken over by the next run immediately, without waiting for leases to expire', async () => {
  await mkdir(root, { recursive: true });
  const { child, exited, ready } = startChild(false);
  await ready;
  child.kill('SIGKILL');
  await exited;

  const { operations } = await readOperations({ workDir: root, jobs: true });
  assert.equal(operations[0].health, 'interrupted');
  assert.equal(operations[0].staleJobs, 2);
  assert.ok(operations[0].runningJobs.every((job) => job.stale && job.leaseExpiresInSeconds > 60));
  assert.match(operations[0].remedies.join(' '), /Re-run the same command/);

  const journal = await OperationJournal.open(path.join(root, 'operations.sqlite'));
  const [operation] = journal.listOperations();
  journal.acquireOperationLock(operation.operationId);
  for (const job of journal.listJobs(operation.operationId)) {
    const result = await journal.executeJob(job, async ({ attempt }) => ({ attempt }), { pollMs: 5, maxWaitMs: 200 });
    assert.equal(result.reused, false);
  }
  assert.deepEqual(journal.jobCounts(operation.operationId), { pending: 0, running: 0, completed: 3, failed: 0 });
  journal.close();
});

test('SIGTERM hands the running jobs back and releases the operation before the process exits', async () => {
  await mkdir(root, { recursive: true });
  const { child, exited, ready } = startChild(true);
  await ready;
  child.kill('SIGTERM');
  const { code } = await exited;
  assert.equal(code, 130);

  const journal = await OperationJournal.open(path.join(root, 'operations.sqlite'), { readOnly: true });
  const [operation] = journal.listOperations();
  assert.deepEqual(journal.jobCounts(operation.operationId), { pending: 3, running: 0, completed: 0, failed: 0 });
  assert.equal(operation.lockPid, null);
  assert.ok(journal.listJobs(operation.operationId).every((job) => job.ownerPid === null && job.leaseOwner === null));
  journal.close();
});
