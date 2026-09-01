import type Database from 'bun:sqlite';
import { logicalJobId, type EnqueuedJob, type JobStatus } from '../indexer/jobs.ts';
import type { LearnReservation } from './reservations.ts';

const TERMINAL = new Set<JobStatus>([
  'failed_permanent', 'exhausted', 'cancelled', 'skipped_missing',
  'superseded', 'blocked_projection',
]);

export type ProjectionState =
  | { kind: 'complete'; job: EnqueuedJob }
  | { kind: 'missing' }
  | { kind: 'conflict'; error: string }
  | { kind: 'terminal'; status: JobStatus; job: EnqueuedJob };

function mapped(row: {
  id: string; doc_id: string; model_key: string; collection: string;
  content_hash: string; index_revision: string; status: JobStatus; attempts: number;
}): EnqueuedJob {
  return {
    id: row.id, docId: row.doc_id, modelKey: row.model_key,
    collection: row.collection, contentHash: row.content_hash,
    indexRevision: row.index_revision, status: row.status, attempts: row.attempts,
  };
}

export function inspectProjection(
  db: Database, reservation: LearnReservation, content: string,
  contentHash: string, modelKey: string, collection: string, revision: string,
  concepts: string[], project: string | null, origin: string | null,
): ProjectionState {
  const doc = db.query<any, [string]>(`
    SELECT type, source_file, concepts, created_at, updated_at, indexed_at,
           project, origin, created_by FROM oracle_documents WHERE id = ?
  `).get(reservation.docId);
  const expectedDoc = {
    type: 'learning', source_file: reservation.sourceFile,
    concepts: JSON.stringify(concepts), created_at: reservation.createdAt,
    updated_at: reservation.createdAt, indexed_at: reservation.createdAt,
    project, origin, created_by: 'arra_learn',
  };
  if (doc && Object.entries(expectedDoc).some(([key, value]) => doc[key] !== value)) {
    return { kind: 'conflict', error: 'Existing document projection does not match immutable learning metadata' };
  }
  const fts = db.query<{ content: string; concepts: string }, [string]>(`
    SELECT content, concepts FROM oracle_fts WHERE id = ?
  `).get(reservation.docId);
  if (fts && (fts.content !== content || fts.concepts !== concepts.join(' '))) {
    return { kind: 'conflict', error: 'Existing FTS projection does not match canonical learning content' };
  }
  const expectedId = logicalJobId(reservation.docId, modelKey, contentHash, revision);
  const candidate = db.query<any, [string]>(`
    SELECT id, doc_id, model_key, collection, content_hash, index_revision, status, attempts
    FROM indexing_jobs_v2 WHERE id = ?
  `).get(expectedId);
  if (candidate && (candidate.doc_id !== reservation.docId || candidate.model_key !== modelKey
    || candidate.content_hash !== contentHash || candidate.index_revision !== revision)) {
    return { kind: 'conflict', error: 'Existing indexing job does not match immutable job identity' };
  }
  const row = db.query<any, [string, string, string, string]>(`
    SELECT id, doc_id, model_key, collection, content_hash, index_revision, status, attempts
    FROM indexing_jobs_v2
    WHERE doc_id = ? AND model_key = ? AND content_hash = ? AND index_revision = ?
  `).get(reservation.docId, modelKey, contentHash, revision);
  if (row && row.collection !== collection) {
    return { kind: 'conflict', error: 'Existing indexing job collection does not match runtime manifest' };
  }
  if (row && TERMINAL.has(row.status)) {
    return { kind: 'terminal', status: row.status, job: mapped(row) };
  }
  if (doc && fts && row) return { kind: 'complete', job: mapped(row) };
  return { kind: 'missing' };
}
