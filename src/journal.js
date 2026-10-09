import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { OperationLockedError, SkillfidError } from './errors.js';
import { stableStringify } from './json.js';

// Short leases with frequent heartbeats keep abandoned jobs recoverable within about a minute.
export const DEFAULT_LEASE_MS = 90 * 1000;
const LOCK_GRACE_MS = 10 * 1000;
const HOST = os.hostname();
const openJournals = new Set();

export class LeaseWaitError extends SkillfidError {
  constructor(message, options = {}) { super(message, { code: 'LEASE_WAIT_TIMEOUT', ...options }); }
}

export function operationId(kind, inputs) {
  const hash = createHash('sha256').update(stableStringify({ kind, inputs }), 'utf8').digest('hex');
  return `${kind}_${hash.slice(0, 16)}`;
}

export function valueHash(value) {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

// Releases every job this process still owns so a later run can take over immediately. Safe to call from signal handlers.
export function releaseAllJournals() {
  for (const journal of openJournals) {
    try { journal.releaseOwnedWork(); } catch { /* the database may already be closed */ }
  }
}

const OPERATION_COLUMNS = { cache_scope: 'TEXT', lock_pid: 'INTEGER', lock_host: 'TEXT', lock_heartbeat_at: 'INTEGER', error: 'TEXT' };
const JOB_COLUMNS = { label: 'TEXT', owner_pid: 'INTEGER', owner_host: 'TEXT', details_json: 'TEXT', reused_from: 'TEXT' };

export class OperationJournal {
  static async open(filePath, options = {}) {
    if (!options.readOnly) await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
    return new OperationJournal(filePath, options);
  }

  constructor(filePath, { clock = () => Date.now(), leaseMs = DEFAULT_LEASE_MS, readOnly = false } = {}) {
    this.clock = clock;
    this.leaseMs = leaseMs;
    this.readOnly = readOnly;
    this.workers = new Map();
    this.timers = new Set();
    this.lockedOperations = new Set();
    this.database = new DatabaseSync(path.resolve(filePath), { readOnly });
    if (readOnly) {
      this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
      return;
    }
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        config_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
        publication_path TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES operations(operation_id),
        stage TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        output_json TEXT,
        output_hash TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(operation_id, stage, entity_id, input_hash)
      );
    `);
    this.#addMissingColumns('operations', OPERATION_COLUMNS);
    this.#addMissingColumns('jobs', JOB_COLUMNS);
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs(operation_id, stage, status, lease_expires_at, created_at);
      CREATE INDEX IF NOT EXISTS jobs_cache_idx ON jobs(stage, entity_id, input_hash, status);
    `);
    openJournals.add(this);
  }

  #addMissingColumns(table, columns) {
    const existing = new Set(this.database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    for (const [name, type] of Object.entries(columns)) if (!existing.has(name)) this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }

  close() {
    if (!this.readOnly) {
      try { this.releaseOwnedWork(); } catch { /* already closed */ }
    }
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
    openJournals.delete(this);
    this.database.close();
  }

  // Returns still-running jobs claimed by this journal to pending and drops the operation locks it holds.
  releaseOwnedWork() {
    if (this.readOnly) return;
    const now = this.clock();
    for (const jobId of this.workers.keys()) {
      this.database.prepare(`
        UPDATE jobs SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, owner_pid = NULL, owner_host = NULL, updated_at = ?
        WHERE job_id = ? AND status = 'running' AND owner_pid = ? AND owner_host = ?
      `).run(now, jobId, process.pid, HOST);
    }
    this.workers.clear();
    for (const id of this.lockedOperations) {
      this.database.prepare('UPDATE operations SET lock_pid = NULL, lock_host = NULL, lock_heartbeat_at = NULL, updated_at = ? WHERE operation_id = ? AND lock_pid = ? AND lock_host = ?').run(now, id, process.pid, HOST);
    }
    this.lockedOperations.clear();
  }

  startOperation({ operationId: id, kind, inputs, config = {}, cacheScope }) {
    const now = this.clock();
    const inputHash = valueHash(inputs);
    this.database.prepare(`
      INSERT INTO operations (operation_id, kind, input_hash, config_json, status, cache_scope, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'running', ?, ?, ?)
      ON CONFLICT(operation_id) DO UPDATE SET status = 'running', error = NULL, config_json = excluded.config_json, updated_at = excluded.updated_at
      WHERE operations.input_hash = excluded.input_hash
    `).run(id, kind, inputHash, stableStringify(config), cacheScope === undefined ? null : valueHash(cacheScope), now, now);
    const operation = this.getOperation(id);
    if (!operation || operation.inputHash !== inputHash) throw new Error(`Operation identity collision for ${id}`);
    return operation;
  }

  // Claims the operation so a second run cannot race this one; a dead or silent owner is replaced.
  acquireOperationLock(id) {
    const now = this.clock();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.database.prepare('SELECT lock_pid, lock_host, lock_heartbeat_at FROM operations WHERE operation_id = ?').get(id);
      const owner = row && lockOwner(row);
      if (owner && this.#lockAlive(owner) && !(owner.pid === process.pid && owner.host === HOST)) {
        throw new OperationLockedError(`Operation ${id} is already running (pid ${owner.pid}${owner.host === HOST ? '' : ` on ${owner.host}`}).`, {
          remedy: 'Wait for it with `skillfid operation wait`, or start an independent run with --fresh.',
          details: { operationId: id, pid: owner.pid, host: owner.host, heartbeatAgeMs: now - owner.heartbeatAt },
        });
      }
      this.database.prepare('UPDATE operations SET lock_pid = ?, lock_host = ?, lock_heartbeat_at = ? WHERE operation_id = ?').run(process.pid, HOST, now, id);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    this.lockedOperations.add(id);
    const timer = setInterval(() => {
      try { this.database.prepare('UPDATE operations SET lock_heartbeat_at = ? WHERE operation_id = ? AND lock_pid = ? AND lock_host = ?').run(this.clock(), id, process.pid, HOST); } catch { /* closed */ }
    }, Math.max(10, Math.floor(this.leaseMs / 3)));
    timer.unref();
    this.timers.add(timer);
  }

  #lockAlive(owner) {
    if (this.clock() - owner.heartbeatAt >= this.leaseMs) return false;
    return owner.host === HOST ? isProcessAlive(owner.pid) : true;
  }

  getOperation(id) {
    const row = this.database.prepare('SELECT * FROM operations WHERE operation_id = ?').get(id);
    return row ? mapOperation(row) : undefined;
  }

  listOperations() {
    return this.database.prepare('SELECT * FROM operations ORDER BY updated_at DESC, operation_id').all().map(mapOperation);
  }

  findResumableOperation(kind, inputs) {
    const row = this.database.prepare(`
      SELECT * FROM operations
      WHERE kind = ? AND input_hash = ? AND status != 'completed'
      ORDER BY updated_at DESC, created_at DESC, operation_id
      LIMIT 1
    `).get(kind, valueHash(inputs));
    return row ? mapOperation(row) : undefined;
  }

  // Combines persisted state with lock liveness: running means a live process holds the operation.
  operationHealth(operation, counts = this.jobCounts(operation.operationId)) {
    if (operation.status === 'completed') return 'completed';
    const owner = operation.lockPid ? { pid: operation.lockPid, host: operation.lockHost, heartbeatAt: operation.lockHeartbeatAt ?? 0 } : undefined;
    if (owner && this.#lockAlive(owner)) return 'running';
    if (operation.status === 'failed') return 'failed';
    // A dead lock owner, or unfinished jobs with nobody running them, mean the run stopped before completing.
    if (owner || counts.pending + counts.running + counts.failed > 0) return 'interrupted';
    // No lock yet: allow a short gap between startOperation and acquireOperationLock before calling it abandoned.
    return this.clock() - operation.updatedAt > LOCK_GRACE_MS ? 'interrupted' : 'running';
  }

  ensureJob({ operationId: id, stage, entityId, inputs, label }) {
    const now = this.clock();
    const inputHash = valueHash(inputs);
    const jobId = `job_${valueHash({ id, stage, entityId, inputHash }).slice(0, 20)}`;
    this.database.prepare(`
      INSERT OR IGNORE INTO jobs (job_id, operation_id, stage, entity_id, input_hash, status, label, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(jobId, id, stage, entityId, inputHash, label ?? null, now, now);
    if (label) this.database.prepare('UPDATE jobs SET label = ? WHERE job_id = ? AND (label IS NULL OR label != ?)').run(label, jobId, label);
    const job = this.getJob(jobId);
    if (job.status === 'pending') {
      const donor = this.#findCachedJob(id, stage, entityId, inputHash);
      if (donor) {
        this.database.prepare(`
          UPDATE jobs SET status = 'completed', output_json = ?, output_hash = ?, reused_from = ?, error = NULL, updated_at = ?
          WHERE job_id = ? AND status = 'pending'
        `).run(donor.output_json, donor.output_hash, donor.job_id, now, jobId);
        return this.getJob(jobId);
      }
    }
    return job;
  }

  // Jobs are reusable across operations that share a cache scope, such as the same dataset settings over an edited corpus.
  #findCachedJob(id, stage, entityId, inputHash) {
    const scope = this.database.prepare('SELECT cache_scope FROM operations WHERE operation_id = ?').get(id)?.cache_scope;
    if (!scope) return undefined;
    return this.database.prepare(`
      SELECT jobs.* FROM jobs JOIN operations ON operations.operation_id = jobs.operation_id
      WHERE jobs.stage = ? AND jobs.entity_id = ? AND jobs.input_hash = ? AND jobs.status = 'completed'
        AND jobs.operation_id != ? AND operations.cache_scope = ?
      ORDER BY jobs.updated_at DESC LIMIT 1
    `).get(stage, entityId, inputHash, id, scope);
  }

  claimJob(jobId, workerId = randomUUID()) {
    const now = this.clock();
    const expires = now + this.leaseMs;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.database.prepare('SELECT status, lease_expires_at, owner_pid, owner_host FROM jobs WHERE job_id = ?').get(jobId);
      let claimed = false;
      if (row && (row.status === 'pending' || row.status === 'failed' || (row.status === 'running' && this.#leaseAbandoned(row, now)))) {
        this.database.prepare(`
          UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?, owner_pid = ?, owner_host = ?, error = NULL, details_json = NULL, updated_at = ?
          WHERE job_id = ?
        `).run(workerId, expires, process.pid, HOST, now, jobId);
        claimed = true;
      }
      this.database.exec('COMMIT');
      if (claimed) this.workers.set(jobId, workerId);
      return claimed ? this.getJob(jobId) : undefined;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  // A lease is abandoned when it expired or its owner process no longer exists on this machine.
  #leaseAbandoned(row, now) {
    if (row.lease_expires_at !== null && row.lease_expires_at <= now) return true;
    return row.owner_host === HOST && Number.isInteger(row.owner_pid) && row.owner_pid !== process.pid && !isProcessAlive(row.owner_pid);
  }

  renewLease(jobId, workerId) {
    const now = this.clock();
    const result = this.database.prepare(`
      UPDATE jobs SET lease_expires_at = ?, updated_at = ?
      WHERE job_id = ? AND status = 'running' AND lease_owner = ?
    `).run(now + this.leaseMs, now, jobId, workerId);
    return result.changes === 1;
  }

  startHeartbeat(jobId, workerId) {
    const timer = setInterval(() => {
      try { this.renewLease(jobId, workerId); } catch { /* closed */ }
    }, Math.max(10, Math.floor(this.leaseMs / 3)));
    timer.unref();
    return () => clearInterval(timer);
  }

  // Runs one job under a lease: waits for a live owner, reuses output completed elsewhere, and records failures with details.
  async executeJob(job, run, { onWait, pollMs = 2000, maxWaitMs = 10 * 60 * 1000 } = {}) {
    if (job.status === 'completed') return { output: job.output, reused: true, job };
    const workerId = randomUUID();
    const waitStartedAt = Date.now();
    let claimed;
    for (;;) {
      const current = this.getJob(job.jobId);
      if (current.status === 'completed') return { output: current.output, reused: true, job: current };
      claimed = this.claimJob(job.jobId, workerId);
      if (claimed) break;
      if (Date.now() - waitStartedAt > maxWaitMs) throw new LeaseWaitError(`Job ${current.label ?? current.entityId} is still leased by pid ${current.ownerPid}.`, { remedy: 'Run `skillfid operation recover` if that process is gone.', details: { jobId: job.jobId, ownerPid: current.ownerPid } });
      onWait?.({ job: current, ownerPid: current.ownerPid, expiresInMs: Math.max(0, (current.leaseExpiresAt ?? 0) - this.clock()) });
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    const stopHeartbeat = this.startHeartbeat(job.jobId, workerId);
    try {
      const output = await run({ jobId: job.jobId, workerId, attempt: claimed.attempts });
      this.completeJob(job.jobId, workerId, output);
      return { output, reused: false, job: this.getJob(job.jobId) };
    } catch (error) {
      try { this.failJob(job.jobId, workerId, error); } catch { /* the lease was lost; the new owner records the outcome */ }
      throw error;
    } finally {
      stopHeartbeat();
      this.workers.delete(job.jobId);
    }
  }

  completeJob(jobId, workerId, output) {
    const now = this.clock();
    const outputJson = stableStringify(output);
    const result = this.database.prepare(`
      UPDATE jobs SET status = 'completed', output_json = ?, output_hash = ?, lease_owner = NULL, lease_expires_at = NULL, owner_pid = NULL, owner_host = NULL, error = NULL, details_json = NULL, updated_at = ?
      WHERE job_id = ? AND status = 'running' AND lease_owner = ?
    `).run(outputJson, valueHash(output), now, jobId, workerId);
    if (result.changes !== 1) throw new Error(`Worker ${workerId} does not own running job ${jobId}`);
    this.workers.delete(jobId);
    return this.getJob(jobId);
  }

  failJob(jobId, workerId, error) {
    const now = this.clock();
    const details = error?.details === undefined ? null : stableStringify(error.details);
    const result = this.database.prepare(`
      UPDATE jobs SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL, owner_pid = NULL, owner_host = NULL, error = ?, details_json = ?, updated_at = ?
      WHERE job_id = ? AND status = 'running' AND lease_owner = ?
    `).run(error instanceof Error ? error.message : String(error), details, now, jobId, workerId);
    if (result.changes !== 1) throw new Error(`Worker ${workerId} does not own running job ${jobId}`);
    this.workers.delete(jobId);
    return this.getJob(jobId);
  }

  // Manual override: abandon leases whose owners are gone so the next run claims them without waiting.
  recoverStaleJobs(operationIdValue) {
    const now = this.clock();
    let recovered = 0;
    for (const job of this.listJobs(operationIdValue)) {
      if (!this.isJobStale(job)) continue;
      this.database.prepare(`
        UPDATE jobs SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, owner_pid = NULL, owner_host = NULL, updated_at = ? WHERE job_id = ? AND status = 'running'
      `).run(now, job.jobId);
      recovered += 1;
    }
    return recovered;
  }

  isJobStale(job) {
    return job.status === 'running' && this.#leaseAbandoned({ lease_expires_at: job.leaseExpiresAt, owner_pid: job.ownerPid, owner_host: job.ownerHost }, this.clock());
  }

  failOperation(id, error) {
    if (error?.code === 'OPERATION_LOCKED') return;
    this.database.prepare("UPDATE operations SET status = 'failed', error = ?, updated_at = ? WHERE operation_id = ? AND status != 'completed'").run(error instanceof Error ? error.message : String(error), this.clock(), id);
  }

  getJob(jobId) {
    const row = this.database.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId);
    return row ? mapJob(row) : undefined;
  }

  listJobs(operationIdValue) {
    return this.database.prepare('SELECT * FROM jobs WHERE operation_id = ? ORDER BY stage, entity_id, created_at').all(operationIdValue).map(mapJob);
  }

  jobCounts(operationIdValue) {
    const counts = { pending: 0, running: 0, completed: 0, failed: 0 };
    for (const row of this.database.prepare('SELECT status, COUNT(*) AS count FROM jobs WHERE operation_id = ? GROUP BY status').all(operationIdValue)) counts[row.status] = Number(row.count);
    return counts;
  }

  stageCounts(operationIdValue) {
    const stages = {};
    for (const row of this.database.prepare('SELECT stage, status, COUNT(*) AS count FROM jobs WHERE operation_id = ? GROUP BY stage, status').all(operationIdValue)) {
      stages[row.stage] ??= { pending: 0, running: 0, completed: 0, failed: 0 };
      stages[row.stage][row.status] = Number(row.count);
    }
    return stages;
  }

  completeOperation(id, publicationPath) {
    this.assertAllJobsCompleted(id);
    const now = this.clock();
    this.database.prepare("UPDATE operations SET status = 'completed', publication_path = ?, error = NULL, updated_at = ? WHERE operation_id = ?").run(publicationPath, now, id);
    return this.getOperation(id);
  }

  assertAllJobsCompleted(id) {
    const incomplete = this.database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE operation_id = ? AND status != 'completed'").get(id).count;
    if (incomplete) throw new Error(`Operation ${id} has ${incomplete} incomplete job(s)`);
  }
}

function lockOwner(row) {
  return row.lock_pid === null || row.lock_pid === undefined ? undefined : { pid: row.lock_pid, host: row.lock_host, heartbeatAt: row.lock_heartbeat_at ?? 0 };
}

function mapOperation(row) {
  return { operationId: row.operation_id, kind: row.kind, inputHash: row.input_hash, config: JSON.parse(row.config_json), status: row.status, publicationPath: row.publication_path, error: row.error ?? null, lockPid: row.lock_pid ?? null, lockHost: row.lock_host ?? null, lockHeartbeatAt: row.lock_heartbeat_at ?? null, createdAt: row.created_at, updatedAt: row.updated_at };
}

function mapJob(row) {
  return { jobId: row.job_id, operationId: row.operation_id, stage: row.stage, entityId: row.entity_id, label: row.label ?? null, inputHash: row.input_hash, status: row.status, attempts: row.attempts, leaseOwner: row.lease_owner, leaseExpiresAt: row.lease_expires_at, ownerPid: row.owner_pid ?? null, ownerHost: row.owner_host ?? null, output: row.output_json ? JSON.parse(row.output_json) : undefined, outputHash: row.output_hash, error: row.error, details: row.details_json ? JSON.parse(row.details_json) : undefined, reusedFrom: row.reused_from ?? null, createdAt: row.created_at, updatedAt: row.updated_at };
}
