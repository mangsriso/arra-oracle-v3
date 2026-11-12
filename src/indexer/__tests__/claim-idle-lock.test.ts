import { afterEach, describe, expect, it } from 'bun:test';
import Database from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimNextJob, enqueueIndexJob } from '../jobs.ts';
import { TEST_MODELS, V2_QUEUE_SQL } from './v2-fixture.ts';

// An idle daemon polls every second. Before 2026-11-12 every poll took the write lock,
// so an empty queue still collided with other writers (5 of the 10 exit-70 crashes
// happened with nothing to claim). Polls with no due work must not need the write lock.
const HASH = 'd'.repeat(64);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function lockedQueue() {
  const dir = mkdtempSync(join(tmpdir(), 'arra-idle-'));
  dirs.push(dir);
  const path = join(dir, 'queue.db');
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(V2_QUEUE_SQL);
  db.exec('PRAGMA busy_timeout = 5');
  const other = new Database(path);
  return { db, lock: () => other.exec('BEGIN IMMEDIATE'), unlock: () => other.exec('COMMIT') };
}

describe('claimNextJob does not take the write lock when nothing is due', () => {
  it('returns null on an empty queue while another connection holds the write lock', () => {
    const q = lockedQueue();
    q.lock();
    try {
      expect(claimNextJob(q.db, 'test', { workerId: 'w' })).toBeNull();
    } finally {
      q.unlock();
    }
  });

  it('returns null while the only job waits for its retry time', () => {
    const q = lockedQueue();
    const now = Date.now();
    enqueueIndexJob(q.db, { docId: 'later', contentHash: HASH, modelKey: 'test', models: TEST_MODELS, now });
    q.db.exec(`UPDATE indexing_jobs_v2 SET status = 'retry_wait', next_attempt_at = ${now + 60_000}`);
    q.lock();
    try {
      expect(claimNextJob(q.db, 'test', { workerId: 'w', now })).toBeNull();
    } finally {
      q.unlock();
    }
  });

  it('still needs the lock, and still claims, when a job is due', () => {
    const q = lockedQueue();
    enqueueIndexJob(q.db, { docId: 'due', contentHash: HASH, modelKey: 'test', models: TEST_MODELS });
    q.lock();
    expect(() => claimNextJob(q.db, 'test', { workerId: 'w' })).toThrow('database is locked');
    q.unlock();
    expect(claimNextJob(q.db, 'test', { workerId: 'w' })?.docId).toBe('due');
  });

  it('still reaps an expired claim', () => {
    const q = lockedQueue();
    const now = Date.now();
    enqueueIndexJob(q.db, { docId: 'lost', contentHash: HASH, modelKey: 'test', models: TEST_MODELS, now });
    const first = claimNextJob(q.db, 'test', { workerId: 'dead', now, leaseMs: 1_000 });
    expect(first?.attempts).toBe(1);
    const again = claimNextJob(q.db, 'test', { workerId: 'w', now: now + 2_000 });
    expect(again?.docId).toBe('lost');
    expect(again?.attempts).toBe(2);
  });
});
