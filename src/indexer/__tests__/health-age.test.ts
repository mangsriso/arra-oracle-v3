import { describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { claimNextJob, enqueueIndexJob } from '../jobs.ts';
import { finishClaim } from '../job-transitions.ts';
import { daemonApiPlugin, makeEventBus, type DaemonApiDeps } from '../../routes/indexer-daemon/index.ts';
import type { WorkerEvent } from '../worker.ts';
import { queueDb, TEST_MODELS } from './v2-fixture.ts';

function health(workers: boolean) {
  const db = queueDb();
  const deps: DaemonApiDeps = {
    db, models: TEST_MODELS, producerEnabled: true, workersEnabled: workers,
    activeModelKey: 'test', indexRevision: TEST_MODELS.test.indexRevision,
    isShuttingDown: () => false, requestShutdown: () => {},
    subscribe: makeEventBus<WorkerEvent>().subscribe,
  };
  const app = new Elysia().use(daemonApiPlugin(deps));
  return { db, get: async () => (await app.handle(new Request('http://localhost/health'))).json() as Promise<any> };
}

describe('indexer health exposes queue staleness for the watchdog', () => {
  it('reports no age for an empty queue and a numeric uptime', async () => {
    const body = await health(true).get();
    expect(body.queue_oldest_age_ms).toBeNull();
    expect(body.last_finished_age_ms).toBeNull();
    expect(body.uptime_s).toBeGreaterThanOrEqual(0);
  });

  it('reports the age of the oldest unfinished job of the active model only', async () => {
    const h = health(true);
    const now = Date.now();
    enqueueIndexJob(h.db, { docId: 'old', contentHash: 'a'.repeat(64), modelKey: 'test', models: TEST_MODELS, now: now - 120_000 });
    enqueueIndexJob(h.db, { docId: 'new', contentHash: 'b'.repeat(64), modelKey: 'test', models: TEST_MODELS, now: now - 1_000 });
    enqueueIndexJob(h.db, { docId: 'foreign', contentHash: 'c'.repeat(64), modelKey: 'other', models: TEST_MODELS, now: now - 900_000 });
    const body = await h.get();
    expect(body.queue_oldest_age_ms).toBeGreaterThanOrEqual(120_000);
    expect(body.queue_oldest_age_ms).toBeLessThan(180_000);
    expect(body.last_finished_age_ms).toBeNull();
  });

  it('reports how long ago a job last finished', async () => {
    const h = health(true);
    const now = Date.now();
    enqueueIndexJob(h.db, { docId: 'doc', contentHash: 'a'.repeat(64), modelKey: 'test', models: TEST_MODELS, now: now - 60_000 });
    const job = claimNextJob(h.db, 'test', { workerId: 'w', now: now - 50_000 })!;
    finishClaim(h.db, job.id, job.claimToken!, 'done', null, now - 40_000);
    const body = await h.get();
    expect(body.queue_oldest_age_ms).toBeNull();
    expect(body.last_finished_age_ms).toBeGreaterThanOrEqual(40_000);
    expect(body.last_finished_age_ms).toBeLessThan(100_000);
  });

  it('reports no staleness when this daemon runs no workers', async () => {
    const h = health(false);
    enqueueIndexJob(h.db, { docId: 'old', contentHash: 'a'.repeat(64), modelKey: 'test', models: TEST_MODELS, now: Date.now() - 120_000 });
    expect((await h.get()).queue_oldest_age_ms).toBeNull();
  });
});
