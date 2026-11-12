import { afterEach, describe, expect, it } from 'bun:test';
import Database from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimNextJob, enqueueIndexJob } from '../jobs.ts';
import { runWorker, type WorkerDeps, type WorkerEvent } from '../worker.ts';
import { TEST_MODELS, V2_QUEUE_SQL } from './v2-fixture.ts';

// Regression for the 2026-10-06 outage: another connection held the SQLite write lock for
// longer than busy_timeout and the daemon died on "database is locked" (exit 70, no log).
const HASH = 'c'.repeat(64);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fileQueue() {
  const dir = mkdtempSync(join(tmpdir(), 'arra-busy-'));
  dirs.push(dir);
  const path = join(dir, 'queue.db');
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(V2_QUEUE_SQL);
  db.exec('PRAGMA busy_timeout = 5');
  const other = new Database(path);
  return {
    db,
    lock: () => other.exec('BEGIN IMMEDIATE'),
    unlock: () => other.exec('COMMIT'),
    status: () => db.query<{ status: string }, []>('SELECT status FROM indexing_jobs_v2').get()?.status,
  };
}

function enqueue(db: Database) {
  enqueueIndexJob(db, { docId: 'doc-1', contentHash: HASH, modelKey: 'test', models: TEST_MODELS });
}

function deps(db: Database, overrides: Partial<WorkerDeps>): WorkerDeps {
  return {
    db,
    workerId: 'worker-busy',
    loadDocument: async () => ({ kind: 'ready', text: 'text', metadata: { content_hash: HASH } }),
    embed: async () => [0.1, 0.2, 0.3],
    upsertVector: async () => {},
    expectedDimension: () => 3,
    isShuttingDown: () => false,
    pollIntervalMs: 1,
    busyBackoffMs: 1,
    attemptTimeoutMs: 5_000,
    heartbeatMs: 10,
    leaseMs: 10_000,
    ...overrides,
  };
}

describe('worker survives SQLite lock contention', () => {
  it('keeps polling while the claim is locked out, then processes the job', async () => {
    const q = fileQueue();
    enqueue(q.db);
    const events: WorkerEvent[] = [];
    let done = false;
    q.lock();
    setTimeout(q.unlock, 60);
    const stats = await runWorker('test', deps(q.db, {
      isShuttingDown: () => done,
      onEvent: (event) => { events.push(event); if (event.type === 'done') done = true; },
    }));
    expect(stats.processed).toBe(1);
    expect(stats.dbBusy).toBeGreaterThan(0);
    expect(events.find((event) => event.type === 'db_busy')).toMatchObject({ op: 'claim', consecutive: 1 });
    expect(q.status()).toBe('done');
  });

  it('a heartbeat that cannot renew during contention is not an unsafe timeout', async () => {
    const q = fileQueue();
    enqueue(q.db);
    const unsafe: string[] = [];
    let done = false;
    const stats = await runWorker('test', deps(q.db, {
      isShuttingDown: () => done,
      embed: async () => {
        q.lock();
        await Bun.sleep(60);
        q.unlock();
        return [0.1, 0.2, 0.3];
      },
      onEvent: (event) => { if (event.type !== 'idle' && event.type !== 'claimed' && event.type !== 'db_busy') done = true; },
      onUnsafeTimeout: (_job, phase) => { unsafe.push(phase); },
    }));
    expect(unsafe).toEqual([]);
    expect(stats.dbBusy).toBeGreaterThan(0);
    expect(stats.processed).toBe(1);
    expect(q.status()).toBe('done');
  });

  it('leaves the claim to the lease reaper when the outcome cannot be recorded', async () => {
    const q = fileQueue();
    enqueue(q.db);
    const events: WorkerEvent[] = [];
    let done = false;
    const stats = await runWorker('test', deps(q.db, {
      heartbeatMs: 1_000,
      isShuttingDown: () => done,
      embed: async () => { q.lock(); throw new Error('network reset'); },
      onEvent: (event) => { events.push(event); if (event.type === 'db_busy') done = true; },
    }));
    q.unlock();
    expect(events.at(-1)).toMatchObject({ type: 'db_busy', op: 'finalize' });
    expect(stats.errors).toBe(1);
    expect(q.status()).toBe('claimed');
    const reclaimed = claimNextJob(q.db, 'test', { workerId: 'next', now: Date.now() + 10_001 });
    expect(reclaimed?.attempts).toBe(2);
    expect(q.db.query<{ outcome: string }, []>(
      'SELECT outcome FROM indexing_job_attempts_v2 ORDER BY attempt_no',
    ).all().map((row) => row.outcome)).toEqual(['lease_expired', 'claimed']);
  });

  it('still fails fast on a database error that is not lock contention', async () => {
    const q = fileQueue();
    q.db.exec('DROP TABLE indexing_job_attempts_v2');
    q.db.exec('DROP TABLE indexing_jobs_v2');
    await expect(runWorker('test', deps(q.db, {}))).rejects.toThrow('no such table');
  });
});
