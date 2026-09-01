import type Database from 'bun:sqlite';

export const MAX_JOB_ATTEMPTS = 3;
export const DEFAULT_LEASE_MS = 90_000;
export const RETRY_DELAYS_MS = [5_000, 30_000] as const;

export type JobStatus =
  | 'pending' | 'claimed' | 'retry_wait' | 'done' | 'failed_permanent'
  | 'exhausted' | 'skipped_missing' | 'superseded'
  | 'blocked_projection' | 'cancelled';

export interface QueueModel {
  collection: string;
  indexRevision: string;
}

export interface EnqueueOptions {
  docId: string;
  contentHash: string;
  modelKey?: string;
  allModels?: boolean;
  models: Record<string, QueueModel>;
  now?: number;
}

export interface EnqueuedJob {
  id: string;
  docId: string;
  modelKey: string;
  collection: string;
  contentHash: string;
  indexRevision: string;
  status: JobStatus;
  attempts: number;
  claimToken?: string;
  leaseUntil?: number;
}

function hash(value: string): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

export function logicalJobId(docId: string, modelKey: string, contentHash: string, revision: string): string {
  return `idx2-${hash(JSON.stringify([docId, modelKey, contentHash, revision])).slice(0, 32)}`;
}

export function enqueueIndexJob(db: Database, opts: EnqueueOptions): EnqueuedJob[] {
  if ((!opts.modelKey && !opts.allModels) || (opts.modelKey && opts.allModels)) {
    throw new Error('Specify exactly one modelKey, or explicit allModels: true');
  }
  const targets = opts.modelKey
    ? [[opts.modelKey, opts.models[opts.modelKey]]] as const
    : Object.entries(opts.models);
  if (targets.length === 0) throw new Error('No embedding models are configured');
  const now = opts.now ?? Date.now();
  const out: EnqueuedJob[] = [];
  const insert = db.prepare(`
    INSERT INTO indexing_jobs_v2
      (id, doc_id, model_key, collection, content_hash, index_revision,
       status, attempts, created_at, next_attempt_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    ON CONFLICT(doc_id, model_key, content_hash, index_revision) DO NOTHING
  `);
  const select = db.query<{
    id: string; doc_id: string; model_key: string; collection: string;
    content_hash: string; index_revision: string; status: JobStatus; attempts: number;
  }, [string, string, string, string]>(`
    SELECT id, doc_id, model_key, collection, content_hash, index_revision, status, attempts
    FROM indexing_jobs_v2
    WHERE doc_id = ? AND model_key = ? AND content_hash = ? AND index_revision = ?
  `);
  for (const [modelKey, model] of targets) {
    if (!model) throw new Error(`Unknown model_key: ${modelKey}`);
    if (!model.indexRevision) throw new Error(`Missing index revision for model_key: ${modelKey}`);
    const id = logicalJobId(opts.docId, modelKey, opts.contentHash, model.indexRevision);
    insert.run(id, opts.docId, modelKey, model.collection, opts.contentHash, model.indexRevision, now, now);
    const row = select.get(opts.docId, modelKey, opts.contentHash, model.indexRevision);
    if (!row) throw new Error(`Failed to enqueue logical job for model_key: ${modelKey}`);
    if (row.collection !== model.collection) {
      throw new Error(`Logical job collection mismatch for model_key: ${modelKey}`);
    }
    out.push({
      id: row.id, docId: row.doc_id, modelKey: row.model_key,
      collection: row.collection, contentHash: row.content_hash,
      indexRevision: row.index_revision, status: row.status, attempts: row.attempts,
    });
  }
  return out;
}

export interface ClaimOptions {
  workerId: string;
  now?: number;
  leaseMs?: number;
  maxAttempts?: number;
}

export function claimNextJob(
  db: Database,
  modelKey: string,
  opts: ClaimOptions,
): EnqueuedJob | null {
  const now = opts.now ?? Date.now();
  const leaseUntil = now + (opts.leaseMs ?? DEFAULT_LEASE_MS);
  const maxAttempts = opts.maxAttempts ?? MAX_JOB_ATTEMPTS;
  const token = crypto.randomUUID();
  db.exec('BEGIN IMMEDIATE');
  try {
    const expired = db.query<{
      id: string; claim_token: string; attempts: number;
    }, [string, number]>(`
      SELECT id, claim_token, attempts FROM indexing_jobs_v2
      WHERE model_key = ? AND status = 'claimed' AND lease_until <= ?
      ORDER BY lease_until, id
    `).all(modelKey, now);
    for (const stale of expired) {
      const exhausted = stale.attempts >= maxAttempts;
      db.prepare(`
        UPDATE indexing_jobs_v2
        SET status = ?, claim_token = NULL, claimed_by = NULL, lease_until = NULL,
            heartbeat_at = NULL, next_attempt_at = ?, finished_at = ?, error = 'lease expired'
        WHERE id = ? AND status = 'claimed' AND claim_token = ? AND lease_until <= ?
      `).run(
        exhausted ? 'exhausted' : 'retry_wait', now, exhausted ? now : null,
        stale.id, stale.claim_token, now,
      );
      db.prepare(`
        UPDATE indexing_job_attempts_v2
        SET finished_at = ?, outcome = ?, error = 'lease expired'
        WHERE job_id = ? AND claim_token = ? AND finished_at IS NULL
      `).run(now, exhausted ? 'exhausted' : 'lease_expired', stale.id, stale.claim_token);
    }
    const row = db.query<{
      id: string; doc_id: string; model_key: string; collection: string;
      content_hash: string; index_revision: string; attempts: number;
    }, [string, string, number, number, number, string, number, number]>(`
      UPDATE indexing_jobs_v2
      SET status = 'claimed', attempts = attempts + 1, claim_token = ?,
          claimed_by = ?, claimed_at = ?, lease_until = ?, heartbeat_at = ?,
          finished_at = NULL, error = NULL, external_write_started_at = NULL,
          cancellation_too_late_at = NULL, cancellation_requested_at = NULL
      WHERE id = (
        SELECT id FROM indexing_jobs_v2
        WHERE model_key = ? AND status IN ('pending','retry_wait')
          AND next_attempt_at <= ? AND attempts < ?
        ORDER BY next_attempt_at, created_at, id LIMIT 1
      )
      RETURNING id, doc_id, model_key, collection, content_hash, index_revision, attempts
    `).get(token, opts.workerId, now, leaseUntil, now, modelKey, now, maxAttempts);
    if (!row) {
      db.exec('COMMIT');
      return null;
    }
    db.prepare(`
      INSERT INTO indexing_job_attempts_v2
        (job_id, attempt_no, claim_token, worker_id, started_at, outcome)
      VALUES (?, (SELECT COALESCE(MAX(attempt_no), 0) + 1
                  FROM indexing_job_attempts_v2 WHERE job_id = ?), ?, ?, ?, 'claimed')
    `).run(row.id, row.id, token, opts.workerId, now);
    db.exec('COMMIT');
    return {
      id: row.id, docId: row.doc_id, modelKey: row.model_key,
      collection: row.collection, contentHash: row.content_hash,
      indexRevision: row.index_revision, status: 'claimed', attempts: row.attempts,
      claimToken: token, leaseUntil,
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function jobsByStatus(
  db: Database,
  modelKey?: string,
): Array<{ status: string; model_key: string; count: number }> {
  if (modelKey) {
    return db.query<{ status: string; model_key: string; count: number }, [string]>(`
      SELECT status, model_key, COUNT(*) AS count FROM indexing_jobs_v2
      WHERE model_key = ? GROUP BY status, model_key ORDER BY model_key, status
    `).all(modelKey);
  }
  return db.query<{ status: string; model_key: string; count: number }, []>(`
    SELECT status, model_key, COUNT(*) AS count FROM indexing_jobs_v2
    GROUP BY status, model_key ORDER BY model_key, status
  `).all();
}
