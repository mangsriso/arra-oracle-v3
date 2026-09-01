import type Database from 'bun:sqlite';
import {
  claimNextJob, DEFAULT_LEASE_MS, type EnqueuedJob,
} from './jobs.ts';
import {
  beginExternalWrite, cancellationRequested, finishClaim, hasValidClaim,
  lateCancellationDetail, renewClaim, retryClaim,
  type TerminalJobStatus,
} from './job-transitions.ts';
import { isPermanentProviderError } from '../vector/provider-error.ts';

export type DocumentLoadResult =
  | { kind: 'ready'; text: string; metadata: Record<string, string | number> }
  | { kind: 'missing' }
  | { kind: 'content_mismatch' }
  | { kind: 'fts_mismatch' };

export interface WorkerDeps {
  db: Database;
  workerId: string;
  loadDocument: (job: EnqueuedJob) => Promise<DocumentLoadResult>;
  embed: (modelKey: string, text: string, signal: AbortSignal) => Promise<number[]>;
  upsertVector: (input: {
    collection: string;
    id: string;
    text: string;
    metadata: Record<string, string | number>;
    vector: number[];
  }) => Promise<void>;
  expectedDimension: (modelKey: string) => number;
  isShuttingDown: () => boolean;
  shutdownSignal?: AbortSignal;
  pollIntervalMs?: number;
  attemptTimeoutMs?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  now?: () => number;
  onEvent?: (event: WorkerEvent) => void;
  onUnsafeTimeout?: (job: EnqueuedJob, phase: string) => void;
}

export type WorkerEvent =
  | { type: 'claimed'; job: EnqueuedJob }
  | { type: 'done'; job: EnqueuedJob; durationMs: number }
  | { type: 'retry'; job: EnqueuedJob; error: string }
  | { type: 'terminal'; job: EnqueuedJob; status: TerminalJobStatus; error?: string }
  | { type: 'stale'; job: EnqueuedJob }
  | { type: 'idle'; modelKey: string };

export interface WorkerStats {
  modelKey: string;
  processed: number;
  errors: number;
  emptyPolls: number;
  staleClaims: number;
}

export class PermanentIndexError extends Error {}

const DOCUMENT_TERMINAL: Record<Exclude<DocumentLoadResult['kind'], 'ready'>, TerminalJobStatus> = {
  missing: 'skipped_missing',
  content_mismatch: 'superseded',
  fts_mismatch: 'blocked_projection',
};

function sleep(ms: number): Promise<void> {
  return Bun.sleep(ms);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runWorker(modelKey: string, deps: WorkerDeps): Promise<WorkerStats> {
  const stats: WorkerStats = {
    modelKey, processed: 0, errors: 0, emptyPolls: 0, staleClaims: 0,
  };
  const now = deps.now ?? Date.now;
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const heartbeatMs = deps.heartbeatMs ?? 15_000;
  const timeoutMs = deps.attemptTimeoutMs ?? 60_000;
  if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0 || heartbeatMs >= leaseMs) {
    throw new Error('Heartbeat interval must be positive and shorter than lease');
  }
  if (timeoutMs >= leaseMs) throw new Error('Attempt timeout must be shorter than lease');

  while (!deps.isShuttingDown()) {
    const job = claimNextJob(deps.db, modelKey, {
      workerId: deps.workerId, now: now(), leaseMs,
    });
    if (!job) {
      stats.emptyPolls++;
      deps.onEvent?.({ type: 'idle', modelKey });
      await sleep(deps.pollIntervalMs ?? 1_000);
      continue;
    }
    deps.onEvent?.({ type: 'claimed', job });
    const started = performance.now();
    const token = job.claimToken!;
    const controller = new AbortController();
    const abortForShutdown = () => controller.abort(new Error('Worker is shutting down'));
    deps.shutdownSignal?.addEventListener('abort', abortForShutdown, { once: true });
    let lostFence = false;
    let phase = 'source-load';
    const timeout = setTimeout(() => {
      controller.abort(new Error(`Indexer attempt timed out during ${phase}`));
      deps.onUnsafeTimeout?.(job, phase);
    }, timeoutMs);
    const heartbeat = setInterval(() => {
      try {
        if (deps.isShuttingDown()) controller.abort(new Error('Worker is shutting down'));
        const renewed = renewClaim(deps.db, job.id, token, now(), leaseMs);
        if (!renewed) {
          lostFence = true;
          controller.abort(new Error('Claim fence was lost'));
        }
        if (cancellationRequested(deps.db, job.id, token)) {
          controller.abort(new Error('Job cancellation requested'));
        }
      } catch (error) {
        lostFence = true;
        controller.abort(error);
        deps.onUnsafeTimeout?.(job, 'heartbeat-database');
      }
    }, heartbeatMs);
    try {
      const document = await deps.loadDocument(job);
      if (document.kind !== 'ready') {
        const status = DOCUMENT_TERMINAL[document.kind];
        if (finishClaim(deps.db, job.id, token, status, document.kind, now())) {
          stats.errors++;
          deps.onEvent?.({ type: 'terminal', job, status, error: document.kind });
        } else {
          stale(stats, deps, job);
        }
        continue;
      }
      if (cancellationRequested(deps.db, job.id, token)) {
        finishClaim(deps.db, job.id, token, 'cancelled', 'cancelled before embedding', now());
        continue;
      }
      phase = 'embedding';
      const vector = await deps.embed(job.modelKey, document.text, controller.signal);
      if (controller.signal.aborted || lostFence) throw controller.signal.reason;
      const dimension = deps.expectedDimension(job.modelKey);
      if (vector.length !== dimension) {
        throw new PermanentIndexError(
          `Embedding dimension mismatch: expected ${dimension}, received ${vector.length}`,
        );
      }
      if (!vector.every(Number.isFinite)) {
        throw new PermanentIndexError('Embedding vector contains a non-finite value');
      }
      if (!hasValidClaim(deps.db, job.id, token, now())) {
        stale(stats, deps, job);
        continue;
      }
      phase = 'vector-upsert';
      if (!beginExternalWrite(deps.db, job.id, token, now())) {
        if (cancellationRequested(deps.db, job.id, token)) {
          finishClaim(deps.db, job.id, token, 'cancelled', 'cancelled before vector write', now());
        } else {
          stale(stats, deps, job);
        }
        continue;
      }
      await deps.upsertVector({
        collection: job.collection,
        id: job.docId,
        text: document.text,
        metadata: document.metadata,
        vector,
      });
      phase = 'vector-committed';
      if (!hasValidClaim(deps.db, job.id, token, now())) {
        stale(stats, deps, job);
        continue;
      }
      const audit = lateCancellationDetail(deps.db, job.id, token);
      if (!finishClaim(deps.db, job.id, token, 'done', audit, now())) {
        stale(stats, deps, job);
        continue;
      }
      stats.processed++;
      deps.onEvent?.({
        type: 'done', job,
        durationMs: Math.round(performance.now() - started),
      });
    } catch (error) {
      const detail = message(error);
      if (cancellationRequested(deps.db, job.id, token)) {
        if (finishClaim(deps.db, job.id, token, 'cancelled', detail, now())) {
          stats.errors++;
          deps.onEvent?.({ type: 'terminal', job, status: 'cancelled', error: detail });
        } else stale(stats, deps, job);
      } else if (error instanceof PermanentIndexError || isPermanentProviderError(error)) {
        if (finishClaim(deps.db, job.id, token, 'failed_permanent', detail, now())) {
          stats.errors++;
          deps.onEvent?.({ type: 'terminal', job, status: 'failed_permanent', error: detail });
        } else {
          stale(stats, deps, job);
        }
      } else {
        const status = retryClaim(deps.db, job.id, token, detail, now());
        if (status === 'stale') {
          stale(stats, deps, job);
        } else {
          stats.errors++;
          if (status === 'retry_wait') deps.onEvent?.({ type: 'retry', job, error: detail });
          else deps.onEvent?.({ type: 'terminal', job, status: 'exhausted', error: detail });
        }
      }
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      deps.shutdownSignal?.removeEventListener('abort', abortForShutdown);
    }
  }
  return stats;
}

function stale(stats: WorkerStats, deps: WorkerDeps, job: EnqueuedJob): void {
  stats.staleClaims++;
  deps.onEvent?.({ type: 'stale', job });
}
