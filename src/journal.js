import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { stableStringify } from './json.js';

export function operationId(kind, inputs) {
  const hash = createHash('sha256').update(stableStringify({ kind, inputs }), 'utf8').digest('hex');
  return `${kind}_${hash.slice(0, 16)}`;
}

export function valueHash(value) {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

export class OperationJournal {
  static async open(filePath, options = {}) {
    if (!options.readOnly) await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
    return new OperationJournal(filePath, options);
  }

  constructor(filePath, { clock = () => Date.now(), leaseMs = 15 * 60 * 1000, readOnly = false } = {}) {
    this.clock = clock;
    this.leaseMs = leaseMs;
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
      CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs(operation_id, stage, status, lease_expires_at, created_at);
    `);
  }

  close() {
    this.database.close();
  }

  startOperation({ operationId: id, kind, inputs, config = {} }) {
    const now = this.clock();
    const inputHash = valueHash(inputs);
    this.database.prepare(`
      INSERT INTO operations (operation_id, kind, input_hash, config_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'running', ?, ?)
      ON CONFLICT(operation_id) DO UPDATE SET status = 'running', updated_at = excluded.updated_at
      WHERE operations.input_hash = excluded.input_hash
    `).run(id, kind, inputHash, stableStringify(config), now, now);
    const operation = this.getOperation(id);
    if (!operation || operation.inputHash !== inputHash) throw new Error(`Operation identity collision for ${id}`);
    return operation;
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

  ensureJob({ operationId: id, stage, entityId, inputs }) {
    const now = this.clock();
    const inputHash = valueHash(inputs);
    const jobId = `job_${valueHash({ id, stage, entityId, inputHash }).slice(0, 20)}`;
    this.database.prepare(`
      INSERT OR IGNORE INTO jobs (job_id, operation_id, stage, entity_id, input_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(jobId, id, stage, entityId, inputHash, now, now);
    return this.getJob(jobId);
  }

  claimJob(jobId, workerId = randomUUID()) {
    const now = this.clock();
    const expires = now + this.leaseMs;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.database.prepare(`
        UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?, error = NULL, updated_at = ?
        WHERE job_id = ? AND (status IN ('pending', 'failed') OR (status = 'running' AND lease_expires_at <= ?))
      `).run(workerId, expires, now, jobId, now);
      this.database.exec('COMMIT');
      return result.changes ? this.getJob(jobId) : undefined;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  renewLease(jobId, workerId) {
    const now = this.clock();
    const result = this.database.prepare(`
      UPDATE jobs SET lease_expires_at = ?, updated_at = ?
      WHERE job_id = ? AND status = 'running' AND lease_owner = ?
    `).run(now + this.leaseMs, now, jobId, workerId);
    return result.changes === 1;
  }

  completeJob(jobId, workerId, output) {
    const now = this.clock();
    const outputJson = stableStringify(output);
    const result = this.database.prepare(`
      UPDATE jobs SET status = 'completed', output_json = ?, output_hash = ?, lease_owner = NULL, lease_expires_at = NULL, error = NULL, updated_at = ?
      WHERE job_id = ? AND status = 'running' AND lease_owner = ?
    `).run(outputJson, valueHash(output), now, jobId, workerId);
    if (result.changes !== 1) throw new Error(`Worker ${workerId} does not own running job ${jobId}`);
    return this.getJob(jobId);
  }

  failJob(jobId, workerId, error) {
    const now = this.clock();
    const result = this.database.prepare(`
      UPDATE jobs SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL, error = ?, updated_at = ?
      WHERE job_id = ? AND status = 'running' AND lease_owner = ?
    `).run(error instanceof Error ? error.message : String(error), now, jobId, workerId);
    if (result.changes !== 1) throw new Error(`Worker ${workerId} does not own running job ${jobId}`);
    return this.getJob(jobId);
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

  completeOperation(id, publicationPath) {
    this.assertAllJobsCompleted(id);
    const now = this.clock();
    this.database.prepare("UPDATE operations SET status = 'completed', publication_path = ?, updated_at = ? WHERE operation_id = ?").run(publicationPath, now, id);
    return this.getOperation(id);
  }

  assertAllJobsCompleted(id) {
    const incomplete = this.database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE operation_id = ? AND status != 'completed'").get(id).count;
    if (incomplete) throw new Error(`Operation ${id} has ${incomplete} incomplete job(s)`);
  }
}

function mapOperation(row) {
  return { operationId: row.operation_id, kind: row.kind, inputHash: row.input_hash, config: JSON.parse(row.config_json), status: row.status, publicationPath: row.publication_path, createdAt: row.created_at, updatedAt: row.updated_at };
}

function mapJob(row) {
  return { jobId: row.job_id, operationId: row.operation_id, stage: row.stage, entityId: row.entity_id, inputHash: row.input_hash, status: row.status, attempts: row.attempts, leaseOwner: row.lease_owner, leaseExpiresAt: row.lease_expires_at, output: row.output_json ? JSON.parse(row.output_json) : undefined, outputHash: row.output_hash, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at };
}
