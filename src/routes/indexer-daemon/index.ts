import { Elysia, t } from 'elysia';
import type Database from 'bun:sqlite';
import { enqueueIndexJob, jobsByStatus, type QueueModel } from '../../indexer/jobs.ts';
import type { WorkerEvent } from '../../indexer/worker.ts';

export interface DaemonApiDeps {
  db: Database;
  models: Record<string, QueueModel>;
  producerEnabled: boolean;
  workersEnabled: boolean;
  activeModelKey: string | null;
  indexRevision: string | null;
  collection?: string | null;
  dimension?: number | null;
  livenessError?: () => string | null;
  isShuttingDown: () => boolean;
  requestShutdown: () => void;
  subscribe: (cb: (ev: WorkerEvent) => void) => () => void;
}

interface IndexingJobRow {
  id: string;
  doc_id: string;
  model_key: string;
  collection: string;
  status: string;
  attempts: number;
  created_at: number;
  claimed_at: number | null;
  finished_at: number | null;
  error: string | null;
  next_attempt_at: number;
  lease_until: number | null;
}

export function daemonApiPlugin(deps: DaemonApiDeps) {
  return new Elysia({ name: 'indexer-daemon' })
    .get('/health', () => {
      const counts = jobsByStatus(deps.db);
      const queueDepth: Record<string, number> = {};
      for (const row of counts) {
        if (row.status === 'pending' || row.status === 'claimed' || row.status === 'retry_wait') {
          queueDepth[row.model_key] = (queueDepth[row.model_key] || 0) + row.count;
        }
      }
      return {
        status: deps.livenessError?.() ? 'degraded' : 'ok',
        service: 'arra-indexer',
        shutting_down: deps.isShuttingDown(),
        queue_depth: queueDepth,
        models: Object.keys(deps.models),
        liveness_error: deps.livenessError?.() ?? null,
        mode: {
          producer_enabled: deps.producerEnabled,
          workers_enabled: deps.workersEnabled,
          active_model_key: deps.activeModelKey,
          index_revision: deps.indexRevision,
          collection: deps.collection ?? null,
          dimension: deps.dimension ?? null,
        },
      };
    })
    .post(
      '/index',
      ({ body, set }) => {
        if (deps.isShuttingDown()) {
          set.status = 503;
          return { error: 'shutting down' };
        }
        if (!deps.producerEnabled) {
          set.status = 503;
          return { error: 'index enqueue producer is disabled', producer_enabled: false };
        }
        if (!body.doc_id || typeof body.doc_id !== 'string') {
          set.status = 400;
          return { error: 'doc_id required' };
        }
        if (!body.content_hash || typeof body.content_hash !== 'string') {
          set.status = 400;
          return { error: 'content_hash required' };
        }
        if (!/^[0-9a-f]{64}$/.test(body.content_hash)) {
          set.status = 400;
          return { error: 'content_hash must be 64 lowercase hexadecimal characters' };
        }
        const fts = deps.db.query<{ content: string }, [string]>(
          'SELECT content FROM oracle_fts WHERE id = ?',
        ).get(body.doc_id);
        if (!fts) {
          set.status = 400;
          return { error: 'doc_id has no authoritative FTS projection' };
        }
        const actualHash = new Bun.CryptoHasher('sha256').update(fts.content).digest('hex');
        if (actualHash !== body.content_hash) {
          set.status = 409;
          return { error: 'content_hash does not match the authoritative FTS projection' };
        }
        if ((!body.model_key && !body.all_models) || (body.model_key && body.all_models)) {
          set.status = 400;
          return { error: 'specify exactly one model_key, or all_models: true' };
        }
        try {
          const jobs = enqueueIndexJob(deps.db, {
            docId: body.doc_id,
            contentHash: body.content_hash,
            modelKey: body.model_key,
            allModels: body.all_models,
            models: deps.models,
          });
          return { jobs };
        } catch (error) {
          set.status = 400;
          return { error: error instanceof Error ? error.message : String(error) };
        }
      },
      {
        body: t.Object({
          doc_id: t.Optional(t.String()),
          model_key: t.Optional(t.String()),
          content_hash: t.Optional(t.String()),
          all_models: t.Optional(t.Boolean()),
        }),
      },
    )
    .get(
      '/jobs',
      ({ query }) => {
        const status = query.status;
        const modelKey = query.model;
        const parsedLimit = Number.parseInt(query.limit || '100', 10);
        const limit = Math.min(Math.max(Number.isFinite(parsedLimit) ? parsedLimit : 100, 1), 1000);

        const where: string[] = [];
        const params: Array<string | number> = [];
        if (status) {
          where.push('status = ?');
          params.push(status);
        }
        if (modelKey) {
          where.push('model_key = ?');
          params.push(modelKey);
        }
        const sql = `SELECT id, doc_id, model_key, collection, status, attempts,
                            created_at, claimed_at, finished_at, error,
                            next_attempt_at, lease_until
                     FROM indexing_jobs_v2
                     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                     ORDER BY created_at DESC
                     LIMIT ?`;
        params.push(limit);
        const rows = deps.db
          .query<IndexingJobRow, typeof params>(sql)
          .all(...params);
        return { jobs: rows, count: rows.length };
      },
      {
        query: t.Object({
          status: t.Optional(t.String()),
          model: t.Optional(t.String()),
          limit: t.Optional(t.String()),
        }),
      },
    )
    .get('/events', ({ set }) => {
      set.headers['Content-Type'] = 'text/event-stream';
      set.headers['Cache-Control'] = 'no-cache';
      set.headers['Connection'] = 'keep-alive';

      const encoder = new TextEncoder();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let aborted = false;
          let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

          const writeSSE = (event: string, data: string) => {
            if (aborted) return;
            try {
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
            } catch {
              aborted = true;
            }
          };

          const unsubscribe = deps.subscribe((ev) => {
            writeSSE(ev.type, JSON.stringify(ev));
          });

          const cleanup = () => {
            if (aborted) return;
            aborted = true;
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            unsubscribe();
            try { controller.close(); } catch { /* already closed */ }
          };

          // Heartbeat to keep the connection alive AND to notice shutdown.
          heartbeatTimer = setInterval(() => {
            if (deps.isShuttingDown()) {
              cleanup();
              return;
            }
            writeSSE('heartbeat', '{}');
          }, 15_000);
        },
        cancel() {
          // Client disconnected — controller already closing.
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    })
    .post('/drain', () => {
      deps.requestShutdown();
      return { status: 'draining' };
    });
}

/**
 * Simple pub-sub bus for worker events. Daemon entrypoint creates one,
 * passes `publish` to each worker's `onEvent`, and `subscribe` to the API.
 */
export interface EventBus<E> {
  publish: (ev: E) => void;
  subscribe: (cb: (ev: E) => void) => () => void;
}

export function makeEventBus<E>(): EventBus<E> {
  const subs = new Set<(ev: E) => void>();
  return {
    publish: (ev) => {
      for (const cb of subs) {
        try { cb(ev); } catch { /* don't let one subscriber kill the others */ }
      }
    },
    subscribe: (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}
