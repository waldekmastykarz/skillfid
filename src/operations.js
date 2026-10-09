import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { EXIT_CODES, SkillfidError } from './errors.js';
import { OperationJournal } from './journal.js';

const THROUGHPUT_WINDOW_MS = 10 * 60 * 1000;

export async function openJournal(workDir, options = {}) {
  const journalPath = path.resolve(workDir, 'operations.sqlite');
  try { await access(journalPath); }
  catch { throw new SkillfidError(`Operation journal not found: ${journalPath}`, { code: 'JOURNAL_NOT_FOUND' }); }
  return { journalPath, journal: await OperationJournal.open(journalPath, options) };
}

async function readProgressSnapshot(workDir) {
  try { return JSON.parse(await readFile(path.resolve(workDir, 'progress.json'), 'utf8')); }
  catch { return undefined; }
}

// One stable, agent-friendly description of an operation: stage counts, running and failed jobs with labels, throughput and what to do next.
export function describeOperation(journal, operation, { jobs: includeJobs = false, failed: includeFailed = true, snapshot } = {}) {
  const now = journal.clock();
  const jobs = journal.listJobs(operation.operationId);
  const counts = journal.jobCounts(operation.operationId);
  const health = journal.operationHealth(operation, counts);
  const stale = jobs.filter((job) => journal.isJobStale(job));
  const lastActivityAt = Math.max(operation.updatedAt, ...jobs.map((job) => job.updatedAt));
  const windowStart = Math.max(operation.createdAt, now - THROUGHPUT_WINDOW_MS);
  const finishedRecently = jobs.filter((job) => job.status === 'completed' && !job.reusedFrom && job.updatedAt >= windowStart && job.attempts > 0).length;
  const throughputPerMinute = health === 'running' && now > windowStart ? finishedRecently / ((now - windowStart) / 60_000) : 0;
  const remaining = counts.pending + counts.running;
  const etaSeconds = health === 'running' && throughputPerMinute > 0 && remaining > 0 ? Math.round((remaining / throughputPerMinute) * 60) : undefined;
  const failedJobs = jobs.filter((job) => job.status === 'failed').map((job) => ({ label: job.label ?? job.entityId, stage: job.stage, attempts: job.attempts, error: job.error, ...(job.details ? { details: job.details } : {}) }));
  const runningJobs = jobs.filter((job) => job.status === 'running').map((job) => ({ label: job.label ?? job.entityId, stage: job.stage, attempts: job.attempts, ownerPid: job.ownerPid, leaseExpiresInSeconds: Math.round(((job.leaseExpiresAt ?? now) - now) / 1000), stale: journal.isJobStale(job) }));
  const remedies = [];
  if (health === 'interrupted') remedies.push(`The run is not active (${counts.completed} jobs are saved). Re-run the same command to continue.`);
  if (health === 'failed') remedies.push(`The last run ended with an error${operation.error ? `: ${firstLine(operation.error)}` : ''}. Re-run the same command to retry; finished work is reused.`);
  if (stale.length) remedies.push(`${stale.length} job${stale.length === 1 ? '' : 's'} hold leases from a stopped process. The next run takes them over; \`skillfid operation recover\` frees them now.`);
  if (counts.failed && health === 'running') remedies.push(`${counts.failed} job${counts.failed === 1 ? '' : 's'} failed; the run keeps going and will report them at the end. Fix or re-run afterwards (finished work is reused).`);
  return {
    operationId: operation.operationId,
    kind: operation.kind,
    inputHash: operation.inputHash,
    config: operation.config,
    status: operation.status,
    health,
    publicationPath: operation.publicationPath,
    error: operation.error,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    lastActivityAt,
    jobs: counts,
    stages: journal.stageCounts(operation.operationId),
    staleJobs: stale.length,
    reusedJobs: jobs.filter((job) => job.reusedFrom).length,
    throughputPerMinute: Number(throughputPerMinute.toFixed(2)),
    ...(etaSeconds === undefined ? {} : { etaSeconds }),
    lock: operation.lockPid ? { pid: operation.lockPid, host: operation.lockHost, heartbeatAt: operation.lockHeartbeatAt } : null,
    ...(includeFailed ? { failedJobs } : {}),
    ...(includeJobs ? { runningJobs } : {}),
    ...(snapshot ? { progress: { current: snapshot.current, progress: snapshot.progress, metrics: snapshot.metrics, etaSeconds: snapshot.etaSeconds, resumeCommand: snapshot.command } } : {}),
    remedies,
  };
}

export async function readOperations({ workDir, operationId, jobs = false, failed = true }) {
  const { journalPath, journal } = await openJournal(workDir, { readOnly: true });
  try {
    const snapshot = await readProgressSnapshot(workDir);
    const selected = operationId ? [journal.getOperation(operationId)].filter(Boolean) : journal.listOperations();
    if (operationId && !selected.length) throw new SkillfidError(`Operation not found: ${operationId}`, { code: 'OPERATION_NOT_FOUND' });
    return { journalPath, operations: selected.map((operation) => describeOperation(journal, operation, { jobs, failed, snapshot: snapshot?.operationId === operation.operationId ? snapshot : undefined })) };
  } finally { journal.close(); }
}

function pickOperation(operations, operationId) {
  if (operationId) return operations.find((operation) => operation.operationId === operationId);
  return operations.find((operation) => operation.health !== 'completed') ?? operations[0];
}

// Blocks until the operation finishes, a job fails, the run stops, or the timeout elapses, so callers poll once per event instead of sleeping blind.
export async function waitForOperation({ workDir, operationId, timeoutSeconds = 120, pollSeconds = 2, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now() }) {
  const deadline = now() + timeoutSeconds * 1000;
  let baselineFailed;
  for (;;) {
    const { journalPath, operations } = await readOperations({ workDir, operationId, jobs: true });
    const operation = pickOperation(operations, operationId);
    if (!operation) throw new SkillfidError('No operations found.', { code: 'OPERATION_NOT_FOUND' });
    baselineFailed ??= operation.jobs.failed;
    let event;
    if (operation.health === 'completed') event = 'completed';
    else if (operation.health === 'failed') event = 'failed';
    else if (operation.health === 'interrupted') event = 'interrupted';
    else if (operation.jobs.failed > baselineFailed) event = 'job_failed';
    else if (now() >= deadline) event = 'timeout';
    if (event) return { journalPath, event, operation, exitCode: event === 'failed' || event === 'interrupted' ? EXIT_CODES.incomplete : 0 };
    await sleep(Math.min(pollSeconds * 1000, Math.max(0, deadline - now())) || 1);
  }
}

export async function recoverOperations({ workDir, operationId }) {
  const { journalPath, journal } = await openJournal(workDir);
  try {
    const targets = operationId ? [journal.getOperation(operationId)].filter(Boolean) : journal.listOperations();
    if (operationId && !targets.length) throw new SkillfidError(`Operation not found: ${operationId}`, { code: 'OPERATION_NOT_FOUND' });
    let recovered = 0;
    for (const operation of targets) {
      if (journal.operationHealth(operation) === 'running' && operation.lockPid) continue;
      recovered += journal.recoverStaleJobs(operation.operationId);
    }
    return { journalPath, recovered };
  } finally { journal.close(); }
}

export function formatOperationStatus(operations, { detail = false } = {}) {
  if (!operations.length) return 'No operations found.';
  const lines = ['Operations'];
  for (const operation of operations) {
    const jobs = operation.jobs;
    const total = jobs.pending + jobs.running + jobs.completed + jobs.failed;
    const activity = operation.health === 'completed' ? `finished ${formatAge(operation.updatedAt)}` : `last activity ${formatAge(operation.lastActivityAt)}`;
    const eta = operation.etaSeconds ? ` · about ${formatDuration(operation.etaSeconds)} remaining` : '';
    lines.push(`  ${operation.kind}  ${operation.health}  ${jobs.completed}/${total} jobs complete${jobs.failed ? `, ${jobs.failed} failed` : ''} · ${activity}${eta}`);
    if (operation.health === 'completed' && !detail) continue;
    for (const [stage, counts] of Object.entries(operation.stages ?? {})) {
      lines.push(`    ${stage}: ${counts.completed} done, ${counts.running} running, ${counts.pending} pending${counts.failed ? `, ${counts.failed} failed` : ''}`);
    }
    for (const job of operation.failedJobs ?? []) lines.push(`    failed: ${job.label}: ${firstLine(job.error ?? 'unknown error')}`);
    for (const job of operation.runningJobs ?? []) lines.push(`    running: ${job.label}${job.stale ? ' (stale lease)' : ''}`);
    for (const remedy of operation.remedies ?? []) lines.push(`    next: ${remedy}`);
  }
  return lines.join('\n');
}

export function formatAge(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function formatDuration(seconds) {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes}m` : `${(minutes / 60).toFixed(1)}h`;
}

function firstLine(text) {
  return String(text).split('\n')[0].slice(0, 300);
}
