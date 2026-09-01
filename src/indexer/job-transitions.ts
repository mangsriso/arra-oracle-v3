import type Database from 'bun:sqlite';
import { MAX_JOB_ATTEMPTS, RETRY_DELAYS_MS, type JobStatus } from './jobs.ts';

export type TerminalJobStatus = Extract<
  JobStatus,
  'done' | 'failed_permanent' | 'exhausted' | 'skipped_missing'
  | 'superseded' | 'blocked_projection' | 'cancelled'
>;

function changed(result: unknown): boolean {
  return ((result as { changes?: number }).changes ?? 0) === 1;
}

export function hasValidClaim(db: Database, id: string, token: string, now = Date.now()): boolean {
  return Boolean(db.query<{ ok: number }, [string, string, number]>(`
    SELECT 1 AS ok FROM indexing_jobs_v2
    WHERE id = ? AND status = 'claimed' AND claim_token = ? AND lease_until > ?
  `).get(id, token, now));
}

export function cancellationRequested(db: Database, id: string, token: string): boolean {
  return Boolean(db.query<{ ok: number }, [string, string]>(`
    SELECT 1 AS ok FROM indexing_jobs_v2
    WHERE id = ? AND status = 'claimed' AND claim_token = ?
      AND cancellation_requested_at IS NOT NULL
      AND external_write_started_at IS NULL
  `).get(id, token));
}

export function beginExternalWrite(
  db: Database, id: string, token: string, now = Date.now(),
): boolean {
  return changed(db.prepare(`
    UPDATE indexing_jobs_v2 SET external_write_started_at = ?
    WHERE id = ? AND status = 'claimed' AND claim_token = ? AND lease_until > ?
      AND cancellation_requested_at IS NULL AND external_write_started_at IS NULL
  `).run(now, id, token, now));
}

export function lateCancellationDetail(db: Database, id: string, token: string): string | null {
  return db.query<{ error: string | null }, [string, string]>(`
    SELECT error FROM indexing_jobs_v2 WHERE id = ? AND status = 'claimed'
      AND claim_token = ? AND cancellation_too_late_at IS NOT NULL
  `).get(id, token)?.error ?? null;
}

export function renewClaim(
  db: Database, id: string, token: string, now: number, leaseMs: number,
): boolean {
  return changed(db.prepare(`
    UPDATE indexing_jobs_v2 SET heartbeat_at = ?, lease_until = ?
    WHERE id = ? AND status = 'claimed' AND claim_token = ? AND lease_until > ?
  `).run(now, now + leaseMs, id, token, now));
}

export function finishClaim(
  db: Database,
  id: string,
  token: string,
  status: TerminalJobStatus,
  error: string | null = null,
  now = Date.now(),
): boolean {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = db.prepare(`
      UPDATE indexing_jobs_v2
      SET status = ?, finished_at = ?, error = ?, claim_token = NULL,
          claimed_by = NULL, lease_until = NULL, heartbeat_at = NULL
      WHERE id = ? AND status = 'claimed' AND claim_token = ? AND lease_until > ?
    `).run(status, now, error, id, token, now);
    if (!changed(result)) {
      db.exec('ROLLBACK');
      return false;
    }
    db.prepare(`
      UPDATE indexing_job_attempts_v2
      SET finished_at = ?, outcome = ?, error = ?
      WHERE job_id = ? AND claim_token = ? AND finished_at IS NULL
    `).run(now, status, error, id, token);
    db.exec('COMMIT');
    return true;
  } catch (cause) {
    db.exec('ROLLBACK');
    throw cause;
  }
}

export function retryClaim(
  db: Database,
  id: string,
  token: string,
  error: string,
  now = Date.now(),
  maxAttempts = MAX_JOB_ATTEMPTS,
): JobStatus | 'stale' {
  const row = db.query<{ attempts: number }, [string, string, number]>(`
    SELECT attempts FROM indexing_jobs_v2
    WHERE id = ? AND status = 'claimed' AND claim_token = ? AND lease_until > ?
  `).get(id, token, now);
  if (!row) return 'stale';
  if (row.attempts >= maxAttempts) {
    return finishClaim(db, id, token, 'exhausted', error, now) ? 'exhausted' : 'stale';
  }
  const delay = RETRY_DELAYS_MS[Math.min(row.attempts - 1, RETRY_DELAYS_MS.length - 1)];
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = db.prepare(`
      UPDATE indexing_jobs_v2
      SET status = 'retry_wait', next_attempt_at = ?, error = ?, claim_token = NULL,
          claimed_by = NULL, lease_until = NULL, heartbeat_at = NULL,
          external_write_started_at = NULL, cancellation_too_late_at = NULL
      WHERE id = ? AND status = 'claimed' AND claim_token = ? AND lease_until > ?
    `).run(now + delay, error, id, token, now);
    if (!changed(result)) {
      db.exec('ROLLBACK');
      return 'stale';
    }
    db.prepare(`
      UPDATE indexing_job_attempts_v2
      SET finished_at = ?, outcome = 'retry_wait', error = ?
      WHERE job_id = ? AND claim_token = ? AND finished_at IS NULL
    `).run(now, error, id, token);
    db.exec('COMMIT');
    return 'retry_wait';
  } catch (cause) {
    db.exec('ROLLBACK');
    throw cause;
  }
}

export function cancelJob(db: Database, id: string, reason: string, now = Date.now()): boolean {
  const pending = db.prepare(`
    UPDATE indexing_jobs_v2
    SET status = 'cancelled', finished_at = ?, error = ?, claim_token = NULL,
        claimed_by = NULL, lease_until = NULL, heartbeat_at = NULL
    WHERE id = ? AND status IN ('pending','retry_wait')
  `).run(now, reason, id);
  if (changed(pending)) return true;
  if (changed(db.prepare(`
    UPDATE indexing_jobs_v2 SET cancellation_requested_at = ?, error = ?
    WHERE id = ? AND status = 'claimed' AND cancellation_requested_at IS NULL
      AND external_write_started_at IS NULL
  `).run(now, reason, id))) return true;
  db.exec('BEGIN IMMEDIATE');
  try {
    const late = changed(db.prepare(`
      UPDATE indexing_jobs_v2 SET cancellation_too_late_at = ?,
        error = 'cancellation requested too late: ' || ?
      WHERE id = ? AND status = 'claimed' AND external_write_started_at IS NOT NULL
        AND cancellation_too_late_at IS NULL
    `).run(now, reason, id));
    if (!late) { db.exec('ROLLBACK'); return false; }
    db.prepare(`
      INSERT INTO indexing_job_events_v2 (job_id, event_type, reason, created_at)
      VALUES (?, 'cancellation_too_late', ?, ?)
    `).run(id, reason, now);
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function requeueTerminalJob(
  db: Database, id: string, reason: string, now = Date.now(),
): boolean {
  if (!reason.trim()) throw new Error('Requeue reason is required');
  db.exec('BEGIN IMMEDIATE');
  try {
    const terminal = db.query<{ ok: number }, [string]>(`
      SELECT 1 AS ok FROM indexing_jobs_v2 WHERE id = ? AND status IN (
        'failed_permanent','exhausted','cancelled','skipped_missing','superseded','blocked_projection'
      )
    `).get(id);
    if (!terminal) { db.exec('ROLLBACK'); return false; }
    db.prepare(`
      INSERT INTO indexing_job_events_v2 (job_id, event_type, reason, created_at)
      VALUES (?, 'operator_requeue', ?, ?)
    `).run(id, reason.trim(), now);
    const updated = db.prepare(`
      UPDATE indexing_jobs_v2
      SET status = 'pending', attempts = 0, next_attempt_at = ?, finished_at = NULL,
          error = ?, claim_token = NULL, claimed_by = NULL, lease_until = NULL,
          heartbeat_at = NULL, cancellation_requested_at = NULL,
          external_write_started_at = NULL, cancellation_too_late_at = NULL
      WHERE id = ? AND status IN (
        'failed_permanent','exhausted','cancelled','skipped_missing','superseded','blocked_projection'
      )
    `).run(now, `operator requeue: ${reason.trim()}`, id);
    if (!changed(updated)) { db.exec('ROLLBACK'); return false; }
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
