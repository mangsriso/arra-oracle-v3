import { describe, expect, it } from 'bun:test';
import { enqueueIndexJob } from '../jobs.ts';
import { claimNextJob } from '../jobs.ts';
import { cancelJob } from '../job-transitions.ts';
import { PermanentIndexError, runWorker, type WorkerDeps } from '../worker.ts';
import { EmbeddingProviderHttpError } from '../../vector/provider-error.ts';
import { queueDb, TEST_MODELS } from './v2-fixture.ts';

const HASH = 'b'.repeat(64);

function setup() {
  const db = queueDb();
  enqueueIndexJob(db, {
    docId: 'doc-1', contentHash: HASH, modelKey: 'test', models: TEST_MODELS, now: 1_000,
  });
  return db;
}

function deps(db: ReturnType<typeof queueDb>, overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  let checks = 0;
  return {
    db,
    workerId: 'worker-test',
    loadDocument: async () => ({
      kind: 'ready', text: 'authoritative text', metadata: { content_hash: HASH },
    }),
    embed: async () => [0.1, 0.2, 0.3],
    upsertVector: async () => {},
    expectedDimension: () => 3,
    isShuttingDown: () => checks++ > 0,
    pollIntervalMs: 1,
    attemptTimeoutMs: 50,
    heartbeatMs: 10,
    leaseMs: 100,
    now: () => 1_001,
    ...overrides,
  };
}

describe('fenced worker', () => {
  it('embeds authoritative text once and upserts full plain-id document', async () => {
    const db = setup();
    const embedded: string[] = [];
    const writes: unknown[] = [];
    const stats = await runWorker('test', deps(db, {
      embed: async (_key, text) => {
        embedded.push(text);
        return [0.1, 0.2, 0.3];
      },
      upsertVector: async (input) => { writes.push(input); },
    }));
    expect(stats.processed).toBe(1);
    expect(embedded).toEqual(['authoritative text']);
    expect(writes).toEqual([{
      collection: 'test_vectors', id: 'doc-1', text: 'authoritative text',
      metadata: { content_hash: HASH }, vector: [0.1, 0.2, 0.3],
    }]);
    expect((db.query('SELECT status FROM indexing_jobs_v2').get() as { status: string }).status)
      .toBe('done');
  });

  it('crash-after-upsert replay converges to one plain-id vector row', async () => {
    const db = setup();
    const vectors = new Map<string, string>();
    await runWorker('test', deps(db, {
      upsertVector: async (input) => {
        vectors.set(input.id, input.text);
        throw new Error('crash after vector commit');
      },
    }));
    db.exec(`UPDATE indexing_jobs_v2 SET next_attempt_at = 0`);
    await runWorker('test', deps(db, {
      now: () => 7_000,
      upsertVector: async (input) => { vectors.set(input.id, input.text); },
    }));
    expect([...vectors.entries()]).toEqual([['doc-1', 'authoritative text']]);
    expect((db.query('SELECT status FROM indexing_jobs_v2').get() as { status: string }).status)
      .toBe('done');
  });

  for (const [kind, status] of [
    ['missing', 'skipped_missing'],
    ['content_mismatch', 'superseded'],
    ['fts_mismatch', 'blocked_projection'],
  ] as const) {
    it(`closes ${kind} as ${status} without embedding`, async () => {
      const db = setup();
      let embeds = 0;
      await runWorker('test', deps(db, {
        loadDocument: async () => ({ kind }),
        embed: async () => { embeds++; return [1, 2, 3]; },
      }));
      expect(embeds).toBe(0);
      expect((db.query('SELECT status FROM indexing_jobs_v2').get() as { status: string }).status)
        .toBe(status);
    });
  }

  it('marks dimension mismatch permanent and never calls upsert', async () => {
    const db = setup();
    let writes = 0;
    await runWorker('test', deps(db, {
      embed: async () => [1],
      upsertVector: async () => { writes++; },
    }));
    expect(writes).toBe(0);
    expect((db.query('SELECT status FROM indexing_jobs_v2').get() as { status: string }).status)
      .toBe('failed_permanent');
  });

  it('marks non-finite vectors permanent before upsert', async () => {
    const db = setup();
    let writes = 0;
    await runWorker('test', deps(db, {
      embed: async () => [1, Number.NaN, 3],
      upsertVector: async () => { writes++; },
    }));
    expect(writes).toBe(0);
    expect((db.query('SELECT status FROM indexing_jobs_v2').get() as { status: string }).status)
      .toBe('failed_permanent');
  });

  it('late provider resolution after deadline cannot upsert', async () => {
    const db = setup();
    let writes = 0;
    await runWorker('test', deps(db, {
      attemptTimeoutMs: 5,
      embed: async (_key, _text, signal) => {
        await Bun.sleep(15);
        expect(signal.aborted).toBe(true);
        return [1, 2, 3];
      },
      upsertVector: async () => { writes++; },
    }));
    expect(writes).toBe(0);
    expect((db.query('SELECT status FROM indexing_jobs_v2').get() as { status: string }).status)
      .toBe('retry_wait');
  });

  it('classifies explicit permanent provider errors without retry', async () => {
    const db = setup();
    await runWorker('test', deps(db, {
      embed: async () => { throw new PermanentIndexError('invalid input'); },
    }));
    expect((db.query('SELECT status FROM indexing_jobs_v2').get() as { status: string }).status)
      .toBe('failed_permanent');
  });

  for (const [status, expected] of [
    [400, 'failed_permanent'], [422, 'failed_permanent'], [499, 'failed_permanent'],
    [408, 'retry_wait'], [429, 'retry_wait'], [500, 'retry_wait'], [599, 'retry_wait'],
  ] as const) {
    it(`classifies provider HTTP ${status} as ${expected}`, async () => {
      const db = setup();
      await runWorker('test', deps(db, {
        embed: async () => { throw new EmbeddingProviderHttpError(status, `provider ${status}`); },
      }));
      expect((db.query('SELECT status FROM indexing_jobs_v2').get() as { status: string }).status)
        .toBe(expected);
    });
  }

  it('keeps an ordinary non-HTTP provider failure retryable', async () => {
    const db = setup();
    await runWorker('test', deps(db, { embed: async () => { throw new Error('network reset'); } }));
    expect(db.query('SELECT status FROM indexing_jobs_v2').get()).toEqual({ status: 'retry_wait' });
  });

  it('cancels before the external-write commit point without writing a vector', async () => {
    const db = setup();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let writes = 0;
    const running = runWorker('test', deps(db, {
      now: Date.now, leaseMs: 200, heartbeatMs: 5, attemptTimeoutMs: 100,
      embed: async () => { entered(); await gate; return [1, 2, 3]; },
      upsertVector: async () => { writes++; },
    }));
    await started;
    const id = (db.query('SELECT id FROM indexing_jobs_v2').get() as { id: string }).id;
    expect(cancelJob(db, id, 'before write')).toBe(true);
    release();
    await running;
    expect(writes).toBe(0);
    expect(db.query('SELECT status FROM indexing_jobs_v2').get()).toEqual({ status: 'cancelled' });
  });

  it('keeps one owner through blocked upsert and records late cancellation while committing done', async () => {
    const db = setup();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const vectors = new Map<string, string>();
    const running = runWorker('test', deps(db, {
      now: Date.now,
      leaseMs: 200,
      heartbeatMs: 5,
      attemptTimeoutMs: 100,
      upsertVector: async (input) => {
        entered();
        await gate;
        vectors.set(input.id, input.text);
      },
    }));
    await started;
    const row = db.query<{ id: string; lease_until: number }, []>(
      'SELECT id, lease_until FROM indexing_jobs_v2',
    ).get()!;
    expect(cancelJob(db, row.id, 'late operator cancellation')).toBe(true);
    const deadline = Date.now() + 500;
    let renewed = row.lease_until;
    while (renewed <= row.lease_until && Date.now() < deadline) {
      await Bun.sleep(2);
      renewed = db.query<{ lease_until: number }, []>(
        'SELECT lease_until FROM indexing_jobs_v2',
      ).get()!.lease_until;
    }
    expect(renewed).toBeGreaterThan(row.lease_until);
    expect(claimNextJob(db, 'test', { workerId: 'racer', now: Date.now(), leaseMs: 200 })).toBeNull();
    release();
    await running;
    expect(vectors.get('doc-1')).toBe('authoritative text');
    expect(db.query('SELECT status, attempts, error FROM indexing_jobs_v2').get())
      .toEqual({
        status: 'done', attempts: 1,
        error: 'cancellation requested too late: late operator cancellation',
      });
    expect(db.query(`SELECT event_type, reason FROM indexing_job_events_v2`).get())
      .toEqual({ event_type: 'cancellation_too_late', reason: 'late operator cancellation' });
  });

  it('rejects invalid heartbeat intervals before claiming', async () => {
    for (const heartbeatMs of [0, 100, 101]) {
      const db = setup();
      await expect(runWorker('test', deps(db, { heartbeatMs, leaseMs: 100 })))
        .rejects.toThrow('Heartbeat interval');
      expect(db.query('SELECT status, attempts FROM indexing_jobs_v2').get())
        .toEqual({ status: 'pending', attempts: 0 });
    }
  });
});
