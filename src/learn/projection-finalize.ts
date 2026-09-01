import type Database from 'bun:sqlite';
import { enqueueIndexJob, type EnqueuedJob } from '../indexer/jobs.ts';
import { inspectProjection } from './projection.ts';
import { LearnConflictError, type LearnReservation } from './reservations.ts';

export class TerminalReplayError extends Error {
  constructor(readonly job: EnqueuedJob) {
    super(`Indexing job is terminal: ${job.status}`);
  }
}

export function finalizeProjection(input: {
  db: Database; reservation: LearnReservation; content: string; contentHash: string;
  concepts: string[]; project: string | null; origin: string | null;
  modelKey: string; collection: string; indexRevision: string; now: number;
}): EnqueuedJob {
  const { db, reservation } = input;
  db.exec('BEGIN IMMEDIATE');
  try {
    const owner = db.query<{ ok: number }, [string, number, string]>(`
      SELECT 1 AS ok FROM learn_reservations_v2
      WHERE request_fingerprint = ? AND generation = ? AND owner_token = ? AND state = 'published'
    `).get(reservation.requestFingerprint, reservation.generation, reservation.ownerToken!);
    if (!owner) throw new Error('Reservation fence was lost before finalize');
    const state = inspectProjection(
      db, reservation, input.content, input.contentHash, input.modelKey,
      input.collection, input.indexRevision, input.concepts, input.project, input.origin,
    );
    if (state.kind === 'conflict') throw new LearnConflictError(state.error);
    if (state.kind === 'terminal') throw new TerminalReplayError(state.job);
    db.prepare(`
      INSERT INTO oracle_documents
          (id, type, source_file, concepts, created_at, updated_at, indexed_at,
           origin, project, created_by)
      VALUES (?, 'learning', ?, ?, ?, ?, ?, ?, ?, 'arra_learn')
      ON CONFLICT(id) DO NOTHING
    `).run(
      reservation.docId, reservation.sourceFile, JSON.stringify(input.concepts),
      reservation.createdAt, reservation.createdAt, reservation.createdAt,
      input.origin, input.project,
    );
    db.prepare(`
      INSERT INTO oracle_fts (id, content, concepts)
      SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM oracle_fts WHERE id = ?)
    `).run(reservation.docId, input.content, input.concepts.join(' '), reservation.docId);
    const [job] = enqueueIndexJob(db, {
      docId: reservation.docId, contentHash: input.contentHash, modelKey: input.modelKey,
      models: { [input.modelKey]: {
        collection: input.collection, indexRevision: input.indexRevision,
      } },
      now: input.now,
    });
    const updated = db.prepare(`
      UPDATE learn_reservations_v2
      SET state = 'committed', content_hash = ?, committed_at = ?,
          owner_token = NULL, lease_until = NULL
      WHERE request_fingerprint = ? AND generation = ? AND owner_token = ?
    `).run(
      input.contentHash, input.now, reservation.requestFingerprint,
      reservation.generation, reservation.ownerToken,
    ) as { changes?: number };
    if ((updated.changes ?? 0) !== 1) throw new Error('Reservation fence was lost during finalize');
    db.exec('COMMIT');
    return job;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
