import type Database from 'bun:sqlite';

export interface LearnReservation {
  requestFingerprint: string;
  idempotencyKeyHash: string | null;
  docId: string;
  sourceFile: string;
  storageRoot: string;
  createdAt: number;
  contentHash: string | null;
  state: 'preparing' | 'published' | 'committed';
  generation: number;
  ownerToken: string | null;
  leaseUntil: number | null;
}

export class LearnConflictError extends Error {}

function row(db: Database, fingerprint: string): LearnReservation | null {
  const value = db.query<{
    request_fingerprint: string; idempotency_key_hash: string | null;
    doc_id: string; source_file: string; storage_root: string; created_at: number;
    content_hash: string | null; state: LearnReservation['state'];
    generation: number; owner_token: string | null; lease_until: number | null;
  }, [string]>(`
    SELECT request_fingerprint, idempotency_key_hash, doc_id, source_file, storage_root,
           created_at, content_hash, state, generation, owner_token, lease_until
    FROM learn_reservations_v2 WHERE request_fingerprint = ?
  `).get(fingerprint);
  return value && {
    requestFingerprint: value.request_fingerprint,
    idempotencyKeyHash: value.idempotency_key_hash,
    docId: value.doc_id,
    sourceFile: value.source_file,
    storageRoot: value.storage_root,
    createdAt: value.created_at,
    contentHash: value.content_hash,
    state: value.state,
    generation: value.generation,
    ownerToken: value.owner_token,
    leaseUntil: value.lease_until,
  };
}

export type ReservationResult =
  | { kind: 'owned'; reservation: LearnReservation }
  | { kind: 'busy'; reservation: LearnReservation }
  | { kind: 'committed'; reservation: LearnReservation };

export function reserveLearning(db: Database, input: {
  fingerprint: string;
  idempotencyKeyHash: string | null;
  docId: string;
  sourceFile: string;
  storageRoot: string;
  createdAt: number;
  ownerToken: string;
  now: number;
  leaseMs: number;
}): ReservationResult {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (input.idempotencyKeyHash) {
      const keyOwner = db.query<{ request_fingerprint: string }, [string]>(`
        SELECT request_fingerprint FROM learn_reservations_v2
        WHERE idempotency_key_hash = ?
      `).get(input.idempotencyKeyHash);
      if (keyOwner && keyOwner.request_fingerprint !== input.fingerprint) {
        throw new LearnConflictError('Idempotency key is already bound to different content');
      }
    }
    const existing = row(db, input.fingerprint);
    if (!existing) {
      db.prepare(`
        INSERT INTO learn_reservations_v2
          (request_fingerprint, idempotency_key_hash, doc_id, source_file, storage_root,
           created_at, state, generation, owner_token, lease_until)
        VALUES (?, ?, ?, ?, ?, ?, 'preparing', 1, ?, ?)
      `).run(
        input.fingerprint, input.idempotencyKeyHash, input.docId, input.sourceFile, input.storageRoot,
        input.createdAt, input.ownerToken, input.now + input.leaseMs,
      );
      db.exec('COMMIT');
      return { kind: 'owned', reservation: row(db, input.fingerprint)! };
    }
    if (input.idempotencyKeyHash && existing.idempotencyKeyHash
      && existing.idempotencyKeyHash !== input.idempotencyKeyHash) {
      throw new LearnConflictError('Canonical request is bound to a different idempotency key');
    }
    if (input.idempotencyKeyHash && !existing.idempotencyKeyHash) {
      db.prepare(`
        UPDATE learn_reservations_v2 SET idempotency_key_hash = ?
        WHERE request_fingerprint = ? AND idempotency_key_hash IS NULL
      `).run(input.idempotencyKeyHash, input.fingerprint);
      existing.idempotencyKeyHash = input.idempotencyKeyHash;
    }
    if (existing.state === 'committed') {
      db.exec('COMMIT');
      return { kind: 'committed', reservation: existing };
    }
    if ((existing.state === 'preparing' || existing.state === 'published')
      && (existing.leaseUntil ?? 0) > input.now) {
      db.exec('COMMIT');
      return { kind: 'busy', reservation: existing };
    }
    db.prepare(`
      UPDATE learn_reservations_v2
      SET generation = generation + 1, owner_token = ?, lease_until = ?,
          state = CASE WHEN state = 'published' THEN 'published' ELSE 'preparing' END
      WHERE request_fingerprint = ?
    `).run(input.ownerToken, input.now + input.leaseMs, input.fingerprint);
    db.exec('COMMIT');
    return { kind: 'owned', reservation: row(db, input.fingerprint)! };
  } catch (error) {
    db.exec('ROLLBACK');
    if (error instanceof LearnConflictError) throw error;
    if (String(error).includes('UNIQUE constraint failed')) {
      throw new LearnConflictError('Learning identity conflicts with an existing reservation');
    }
    throw error;
  }
}

export function reopenCommittedReservation(
  db: Database, fingerprint: string, ownerToken: string, now: number, leaseMs: number,
): LearnReservation | null {
  const updated = db.prepare(`
    UPDATE learn_reservations_v2
    SET state = 'published', generation = generation + 1,
        owner_token = ?, lease_until = ?
    WHERE request_fingerprint = ? AND state = 'committed'
  `).run(ownerToken, now + leaseMs, fingerprint) as { changes?: number };
  if ((updated.changes ?? 0) !== 1) return null;
  const reservation = row(db, fingerprint);
  if (!reservation) throw new Error('Reservation disappeared during reconciliation');
  return reservation;
}

export function markReservationPublished(
  db: Database, reservation: LearnReservation, contentHash: string,
): boolean {
  const result = db.prepare(`
    UPDATE learn_reservations_v2
    SET state = 'published', content_hash = ?
    WHERE request_fingerprint = ? AND generation = ? AND owner_token = ?
      AND state IN ('preparing','published')
  `).run(
    contentHash, reservation.requestFingerprint, reservation.generation,
    reservation.ownerToken,
  ) as { changes?: number };
  return (result.changes ?? 0) === 1;
}

export function renewReservationLease(
  db: Database, reservation: LearnReservation, now: number, leaseMs: number,
): boolean {
  const result = db.prepare(`
    UPDATE learn_reservations_v2 SET lease_until = ?
    WHERE request_fingerprint = ? AND generation = ? AND owner_token = ?
      AND state IN ('preparing','published') AND lease_until > ?
  `).run(
    now + leaseMs, reservation.requestFingerprint, reservation.generation,
    reservation.ownerToken, now,
  ) as { changes?: number };
  return (result.changes ?? 0) === 1;
}

export function releasePublishedReservation(db: Database, reservation: LearnReservation): void {
  db.prepare(`
    UPDATE learn_reservations_v2 SET owner_token = NULL, lease_until = 0
    WHERE request_fingerprint = ? AND generation = ? AND owner_token = ?
      AND state IN ('preparing','published')
  `).run(reservation.requestFingerprint, reservation.generation, reservation.ownerToken);
}
