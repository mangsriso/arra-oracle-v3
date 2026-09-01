import type Database from 'bun:sqlite';
import type { EmbeddingModelPreset } from '../vector/config.ts';
import { resolveAsyncIndexerConfig } from '../vector/indexer-config.ts';
import type { EnqueuedJob, JobStatus } from '../indexer/jobs.ts';
import {
  canonicalizeLearnRequest, documentIdentity, idempotencyKeyHash,
  renderLearning, requestFingerprint, sha256, type LearnRequest,
} from './canonical.ts';
import { publishNoReplace } from './publication.ts';
import { inspectProjection } from './projection.ts';
import { finalizeProjection, TerminalReplayError } from './projection-finalize.ts';
import {
  LearnConflictError, markReservationPublished, releasePublishedReservation, reopenCommittedReservation,
  renewReservationLease, reserveLearning, type LearnReservation,
} from './reservations.ts';

export { LearnConflictError } from './reservations.ts';
export type LearnOutcome = 'created' | 'replayed' | 'reconciled' | 'partial' | 'degraded';

export interface LearnPersistenceResult {
  success: boolean; outcome: LearnOutcome;
  file: string; id: string;
  embedding: 'enqueued' | 'failed';
  durability: { level: 'full' | 'file' | 'missing'; content_hash: string; request_fingerprint: string };
  indexing: {
    status: 'pending' | 'existing' | 'missing' | JobStatus;
    job_id: string | null; model_key: string; index_revision: string;
  };
  replayed: boolean; reconciled: boolean;
  error?: string;
}

export interface LearnPersistenceDeps {
  sqlite: Database; learningDir: string; sourceFilePrefix: string;
  models: Record<string, EmbeddingModelPreset>;
  env?: Record<string, string | undefined>;
  now?: () => number; reservationLeaseMs?: number; waitMs?: number;
  faults?: {
    afterFilePublish?: () => void;
    afterPublish?: () => void;
    beforeFinalize?: () => void;
    beforeDirectorySync?: () => void;
    beforeTempCleanup?: () => void;
    afterLink?: () => void;
    onSyncPath?: (path: string) => void;
    syncOperation?: (path: string) => Promise<void>;
  };
}

function joinPath(left: string, right: string): string {
  return `${left.replace(/\/+$/, '')}/${right.replace(/^\/+/, '')}`;
}

function assertDurableSqlite(db: Database): void {
  const synchronous = db.query<{ synchronous: number }, []>('PRAGMA synchronous').get()?.synchronous;
  if (synchronous !== 2 && synchronous !== 3) {
    throw new Error('Async learn requires SQLite synchronous=FULL or EXTRA');
  }
  const path = db.query<{ file: string }, []>('PRAGMA database_list').all()
    .find((item) => item.file)?.file;
  if (!path) throw new Error('Async learn requires a file-backed SQLite database');
  const journal = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode;
  if (journal?.toLowerCase() !== 'wal') throw new Error('Async learn requires SQLite WAL mode');
}

export async function persistAsyncLearning(
  deps: LearnPersistenceDeps,
  input: LearnRequest,
): Promise<LearnPersistenceResult> {
  assertDurableSqlite(deps.sqlite);
  const runtime = resolveAsyncIndexerConfig(deps.models, deps.env);
  if (!runtime.producerEnabled || !runtime.modelKey || !runtime.collection || !runtime.indexRevision) {
    throw new Error('Async learn producer is disabled');
  }
  const canonical = canonicalizeLearnRequest(input);
  const fingerprint = requestFingerprint(canonical);
  const keyHash = idempotencyKeyHash(input.idempotencyKey);
  const nowFn = deps.now ?? Date.now;
  const ownerToken = crypto.randomUUID();
  const initialNow = nowFn();
  const identity = documentIdentity(canonical, fingerprint, initialNow);
  const sourceFile = joinPath(deps.sourceFilePrefix, identity.filename);
  const leaseMs = deps.reservationLeaseMs ?? 90_000;
  const deadline = initialNow + (deps.waitMs ?? 2_000);
  let reserved;
  while (true) {
    reserved = reserveLearning(deps.sqlite, {
      fingerprint, idempotencyKeyHash: keyHash, docId: identity.id, sourceFile,
      storageRoot: deps.learningDir, createdAt: initialNow, ownerToken, now: nowFn(), leaseMs,
    });
    if (reserved.kind !== 'busy') break;
    if (nowFn() >= deadline) throw new Error('Identical learning reservation is still in progress');
    await Bun.sleep(5);
  }
  let reservation = reserved.reservation;
  const content = renderLearning(canonical, fingerprint, reservation.createdAt);
  const contentHash = sha256(content);
  const reservedFilename = reservation.sourceFile.split('/').at(-1);
  if (!reservedFilename) throw new Error('Reservation has an invalid source file');
  const finalPath = joinPath(reservation.storageRoot, reservedFilename);
  if (reserved.kind === 'committed') {
    const fileMatches = await Bun.file(finalPath).exists()
      && await Bun.file(finalPath).text() === content;
    const state = inspectProjection(
      deps.sqlite, reservation, content, contentHash, runtime.modelKey, runtime.collection,
      runtime.indexRevision, canonical.concepts, canonical.project, canonical.origin,
    );
    if (state.kind === 'conflict') throw new LearnConflictError(state.error);
    if (state.kind === 'terminal') {
      if (!fileMatches) {
        return degradedResult(
          reservation, contentHash, runtime, state.job, 'missing',
          'Canonical file is missing or corrupt; terminal indexing history is not fully durable',
        );
      }
      return degradedResult(reservation, contentHash, runtime, state.job);
    }
    if (fileMatches && state.kind === 'complete') {
      return result('replayed', reservation, contentHash, runtime, state.job);
    }
    const reopened = reopenCommittedReservation(
      deps.sqlite, fingerprint, ownerToken, nowFn(), leaseMs,
    );
    if (!reopened) {
      await Bun.sleep(5);
      return persistAsyncLearning({ ...deps, waitMs: Math.max(0, deadline - nowFn()) }, input);
    }
    reservation = reopened;
  }
  let publication: Awaited<ReturnType<typeof publishNoReplace>>;
  try {
    publication = await publishNoReplace(finalPath, content, ownerToken, fingerprint, {
      beforeDirectorySync: deps.faults?.beforeDirectorySync,
      beforeTempCleanup: deps.faults?.beforeTempCleanup,
      afterLink: deps.faults?.afterLink,
      onSyncPath: deps.faults?.onSyncPath,
      syncOperation: deps.faults?.syncOperation,
      renewLease: () => renewReservationLease(deps.sqlite, reservation, nowFn(), leaseMs),
      renewIntervalMs: Math.max(1, Math.floor(leaseMs / 3)),
    });
  } catch (error) {
    releasePublishedReservation(deps.sqlite, reservation);
    const filePublished = await Bun.file(finalPath).exists()
      && await Bun.file(finalPath).text() === content;
    if (filePublished) {
      return partialResult(
        reservation, contentHash, fingerprint, runtime,
        `canonical file was published but durability confirmation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw error;
  }
  try {
    deps.faults?.afterFilePublish?.();
  } catch (error) {
    releasePublishedReservation(deps.sqlite, reservation);
    return partialResult(
      reservation, contentHash, fingerprint, runtime,
      `durable file published before persistence interruption: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!markReservationPublished(deps.sqlite, reservation, contentHash)) {
    return partialResult(
      reservation, contentHash, fingerprint, runtime,
      'durable file published but reservation fence was lost before database commit',
    );
  }
  try {
    deps.faults?.afterPublish?.();
    deps.faults?.beforeFinalize?.();
    const job = finalizeProjection({
      db: deps.sqlite, reservation, content, contentHash, concepts: canonical.concepts,
      project: canonical.project, origin: canonical.origin, modelKey: runtime.modelKey,
      collection: runtime.collection, indexRevision: runtime.indexRevision, now: nowFn(),
    });
    return result(publication === 'adopted' ? 'reconciled' : 'created', reservation, contentHash, runtime, job);
  } catch (error) {
    if (error instanceof TerminalReplayError) {
      releasePublishedReservation(deps.sqlite, reservation);
      return degradedResult(reservation, contentHash, runtime, error.job);
    }
    if (error instanceof LearnConflictError) {
      releasePublishedReservation(deps.sqlite, reservation);
      throw error;
    }
    releasePublishedReservation(deps.sqlite, reservation);
    return partialResult(reservation, contentHash, fingerprint, runtime,
      `durable file exists; retry identically to reconcile: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function degradedResult(
  reservation: LearnReservation, contentHash: string,
  runtime: ReturnType<typeof resolveAsyncIndexerConfig>, job: EnqueuedJob,
  durabilityLevel: LearnPersistenceResult['durability']['level'] = 'full',
  overrideError?: string,
): LearnPersistenceResult {
  return {
    success: false, outcome: 'degraded', file: reservation.sourceFile, id: reservation.docId,
    embedding: 'failed',
    durability: {
      level: durabilityLevel, content_hash: contentHash,
      request_fingerprint: reservation.requestFingerprint,
    },
    indexing: {
      status: job.status, job_id: job.id, model_key: runtime.modelKey!,
      index_revision: runtime.indexRevision!,
    },
    replayed: true, reconciled: false,
    error: overrideError
      ?? `Indexing job is terminal (${job.status}); an operator must explicitly requeue it with a reason`,
  };
}

function partialResult(
  reservation: LearnReservation, contentHash: string, fingerprint: string,
  runtime: ReturnType<typeof resolveAsyncIndexerConfig>, error: string,
): LearnPersistenceResult {
  return {
    success: false, outcome: 'partial', file: reservation.sourceFile, id: reservation.docId,
    embedding: 'failed',
    durability: { level: 'file', content_hash: contentHash, request_fingerprint: fingerprint },
    indexing: {
      status: 'missing', job_id: null, model_key: runtime.modelKey!,
      index_revision: runtime.indexRevision!,
    },
    replayed: false, reconciled: false, error,
  };
}

function result(
  outcome: 'created' | 'replayed' | 'reconciled',
  reservation: LearnReservation, contentHash: string,
  runtime: ReturnType<typeof resolveAsyncIndexerConfig>,
  job: EnqueuedJob,
): LearnPersistenceResult {
  return {
    success: true, outcome, file: reservation.sourceFile, id: reservation.docId,
    embedding: 'enqueued',
    durability: {
      level: 'full', content_hash: contentHash,
      request_fingerprint: reservation.requestFingerprint,
    },
    indexing: {
      status: job.status === 'pending' ? 'pending' : 'existing', job_id: job.id,
      model_key: runtime.modelKey!, index_revision: runtime.indexRevision!,
    },
    replayed: outcome === 'replayed', reconciled: outcome === 'reconciled',
  };
}
