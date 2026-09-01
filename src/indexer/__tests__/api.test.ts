import { describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { enqueueIndexJob } from '../jobs.ts';
import { daemonApiPlugin, makeEventBus, type DaemonApiDeps } from '../../routes/indexer-daemon/index.ts';
import type { WorkerEvent } from '../worker.ts';
import { queueDb, TEST_MODELS } from './v2-fixture.ts';

const CONTENT = 'authoritative API projection';
const HASH = new Bun.CryptoHasher('sha256').update(CONTENT).digest('hex');

function harness(mode: { producer?: boolean; workers?: boolean } = {}) {
  const db = queueDb();
  db.prepare('INSERT INTO oracle_fts (id, content, concepts) VALUES (?, ?, ?)')
    .run('doc', CONTENT, '');
  const flag = { value: false };
  const bus = makeEventBus<WorkerEvent>();
  const deps: DaemonApiDeps = {
    db,
    models: TEST_MODELS,
    producerEnabled: mode.producer ?? true,
    workersEnabled: mode.workers ?? false,
    activeModelKey: 'test',
    indexRevision: TEST_MODELS.test.indexRevision,
    isShuttingDown: () => flag.value,
    requestShutdown: () => { flag.value = true; },
    subscribe: bus.subscribe,
  };
  return { db, flag, bus, app: new Elysia().use(daemonApiPlugin(deps)) };
}

function request(path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('indexer daemon API v2', () => {
  it('health preserves status and exposes disabled-worker mode', async () => {
    const { app } = harness();
    const response = await app.handle(request('/health'));
    const body = await response.json() as any;
    expect(body.status).toBe('ok');
    expect(body.mode).toEqual({
      producer_enabled: true,
      workers_enabled: false,
      active_model_key: 'test',
      index_revision: TEST_MODELS.test.indexRevision,
      collection: null,
      dimension: null,
    });
  });

  it('health exposes supervised worker degradation', async () => {
    const h = harness();
    const app = new Elysia().use(daemonApiPlugin({
      db: h.db, models: TEST_MODELS, producerEnabled: true, workersEnabled: true,
      activeModelKey: 'test', indexRevision: TEST_MODELS.test.indexRevision,
      isShuttingDown: () => true, requestShutdown: () => {}, subscribe: h.bus.subscribe,
      livenessError: () => 'heartbeat database failed',
    } as DaemonApiDeps));
    const body = await (await app.handle(request('/health'))).json() as any;
    expect(body.status).toBe('degraded');
    expect(body.liveness_error).toBe('heartbeat database failed');
  });

  it('rejects silent fan-out and requires the authoritative content hash', async () => {
    const { app } = harness();
    expect((await app.handle(request('/index', { doc_id: 'doc' }))).status).toBe(400);
    expect((await app.handle(request('/index', {
      doc_id: 'doc', content_hash: HASH,
    }))).status).toBe(400);
  });

  it('rejects malformed, uppercase, missing-projection, and mismatched hashes', async () => {
    const { app } = harness();
    for (const content_hash of ['abc', HASH.toUpperCase(), '0'.repeat(64)]) {
      expect((await app.handle(request('/index', {
        doc_id: 'doc', content_hash, model_key: 'test',
      }))).status).toBe(content_hash === '0'.repeat(64) ? 409 : 400);
    }
    expect((await app.handle(request('/index', {
      doc_id: 'missing', content_hash: HASH, model_key: 'test',
    }))).status).toBe(400);
  });

  for (const producer of [false, true]) {
    for (const workers of [false, true]) {
      it(`producer=${producer} workers=${workers} enforces enqueue mode without claims`, async () => {
        const { app, db } = harness({ producer, workers });
        const response = await app.handle(request('/index', {
          doc_id: 'doc', content_hash: HASH, model_key: 'test',
        }));
        expect(response.status).toBe(producer ? 200 : 503);
        expect((db.query('SELECT COUNT(*) AS n FROM indexing_jobs_v2').get() as { n: number }).n)
          .toBe(producer ? 1 : 0);
        expect((db.query('SELECT COUNT(*) AS n FROM indexing_job_attempts_v2').get() as { n: number }).n)
          .toBe(0);
      });
    }
  }

  it('enqueues one explicit key and idempotently returns the same job', async () => {
    const { app, db } = harness();
    const body = { doc_id: 'doc', content_hash: HASH, model_key: 'test' };
    const first = await (await app.handle(request('/index', body))).json() as any;
    const second = await (await app.handle(request('/index', body))).json() as any;
    expect(first.jobs).toHaveLength(1);
    expect(second.jobs[0].id).toBe(first.jobs[0].id);
    expect((db.query('SELECT COUNT(*) AS count FROM indexing_jobs_v2').get() as { count: number }).count)
      .toBe(1);
  });

  it('allows fan-out only with all_models true', async () => {
    const { app } = harness();
    const response = await app.handle(request('/index', {
      doc_id: 'doc', content_hash: HASH, all_models: true,
    }));
    const body = await response.json() as any;
    expect(body.jobs.map((job: any) => job.modelKey).sort()).toEqual(['other', 'test']);
  });

  it('lists v2 jobs and supports filters', async () => {
    const { app, db } = harness();
    enqueueIndexJob(db, {
      docId: 'a', contentHash: HASH, modelKey: 'test', models: TEST_MODELS,
    });
    enqueueIndexJob(db, {
      docId: 'b', contentHash: HASH, modelKey: 'other', models: TEST_MODELS,
    });
    const body = await (await app.handle(request('/jobs?model=other'))).json() as any;
    expect(body.count).toBe(1);
    expect(body.jobs[0].doc_id).toBe('b');
  });

  it('clamps list limit to 1..1000', async () => {
    const { app } = harness();
    const low = await (await app.handle(request('/jobs?limit=-20'))).json() as any;
    const high = await (await app.handle(request('/jobs?limit=999999'))).json() as any;
    expect(low.count).toBeLessThanOrEqual(1);
    expect(high.count).toBeLessThanOrEqual(1000);
  });

  it('drain blocks enqueue and leaves queue unchanged', async () => {
    const { app, flag, db } = harness();
    expect((await app.handle(new Request('http://localhost/drain', { method: 'POST' }))).status)
      .toBe(200);
    expect(flag.value).toBe(true);
    expect((await app.handle(request('/index', {
      doc_id: 'doc', content_hash: HASH, model_key: 'test',
    }))).status).toBe(503);
    expect((db.query('SELECT COUNT(*) AS count FROM indexing_jobs_v2').get() as { count: number }).count)
      .toBe(0);
  });

  it('event bus isolates throwing subscribers', () => {
    const bus = makeEventBus<{ value: number }>();
    const seen: number[] = [];
    bus.subscribe(() => { throw new Error('boom'); });
    bus.subscribe((event) => seen.push(event.value));
    bus.publish({ value: 1 });
    expect(seen).toEqual([1]);
  });
});
