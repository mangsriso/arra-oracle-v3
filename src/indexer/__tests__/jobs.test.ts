import { describe, expect, it } from 'bun:test';
import {
  claimNextJob, enqueueIndexJob, jobsByStatus,
} from '../jobs.ts';
import {
  cancelJob, finishClaim, hasValidClaim, renewClaim, requeueTerminalJob, retryClaim,
} from '../job-transitions.ts';
import { queueDb, TEST_MODELS } from './v2-fixture.ts';

const HASH = 'a'.repeat(64);

function enqueue(db = queueDb(), docId = 'doc-1') {
  return {
    db,
    job: enqueueIndexJob(db, {
      docId, contentHash: HASH, modelKey: 'test', models: TEST_MODELS, now: 1_000,
    })[0],
  };
}

describe('v2 enqueue', () => {
  it('requires explicit single-model or all-model operation', () => {
    const db = queueDb();
    expect(() => enqueueIndexJob(db, {
      docId: 'doc', contentHash: HASH, models: TEST_MODELS,
    })).toThrow('Specify exactly one');
    const jobs = enqueueIndexJob(db, {
      docId: 'doc', contentHash: HASH, allModels: true, models: TEST_MODELS, now: 1,
    });
    expect(jobs.map((job) => job.modelKey).sort()).toEqual(['other', 'test']);
  });

  it('fails closed for an unknown key and creates no row', () => {
    const db = queueDb();
    expect(() => enqueueIndexJob(db, {
      docId: 'doc', contentHash: HASH, modelKey: 'missing', models: TEST_MODELS,
    })).toThrow('Unknown model_key');
    expect((db.query('SELECT COUNT(*) AS count FROM indexing_jobs_v2').get() as { count: number }).count)
      .toBe(0);
  });

  it('returns the existing logical job on identical enqueue', () => {
    const db = queueDb();
    const first = enqueue(db).job;
    const second = enqueue(db).job;
    expect(second.id).toBe(first.id);
    expect((db.query('SELECT COUNT(*) AS count FROM indexing_jobs_v2').get() as { count: number }).count)
      .toBe(1);
  });
});

describe('v2 claims and fencing', () => {
  it('claims due work atomically and appends an attempt', () => {
    const { db } = enqueue();
    const job = claimNextJob(db, 'test', { workerId: 'worker-a', now: 1_000, leaseMs: 90 });
    expect(job?.attempts).toBe(1);
    expect(job?.claimToken).toBeTruthy();
    expect(claimNextJob(db, 'test', { workerId: 'worker-b', now: 1_001 })).toBeNull();
    const attempt = db.query<{ outcome: string }, []>(
      'SELECT outcome FROM indexing_job_attempts_v2',
    ).get();
    expect(attempt?.outcome).toBe('claimed');
  });

  it('renews only a live token and rejects stale completion', () => {
    const { db } = enqueue();
    const job = claimNextJob(db, 'test', { workerId: 'worker', now: 1_000, leaseMs: 100 })!;
    expect(renewClaim(db, job.id, job.claimToken!, 1_050, 100)).toBe(true);
    expect(hasValidClaim(db, job.id, job.claimToken!, 1_149)).toBe(true);
    expect(finishClaim(db, job.id, 'stale-token', 'done', null, 1_060)).toBe(false);
    expect(finishClaim(db, job.id, job.claimToken!, 'done', null, 1_060)).toBe(true);
  });

  it('reclaims an expired lease and the old token cannot finish', () => {
    const { db } = enqueue();
    const old = claimNextJob(db, 'test', { workerId: 'old', now: 1_000, leaseMs: 10 })!;
    const fresh = claimNextJob(db, 'test', { workerId: 'fresh', now: 1_011, leaseMs: 90 })!;
    expect(fresh.claimToken).not.toBe(old.claimToken);
    expect(finishClaim(db, old.id, old.claimToken!, 'done', null, 1_012)).toBe(false);
    expect(finishClaim(db, fresh.id, fresh.claimToken!, 'done', null, 1_012)).toBe(true);
    expect(db.query('SELECT finished_at, outcome FROM indexing_job_attempts_v2 WHERE attempt_no = 1').get())
      .toEqual({ finished_at: 1_011, outcome: 'lease_expired' });
  });

  it('three consecutive process deaths close every attempt and exhaust directly', () => {
    const { db } = enqueue();
    const first = claimNextJob(db, 'test', { workerId: 'dead-1', now: 1_000, leaseMs: 10 });
    expect(first?.attempts).toBe(1);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const expiredAt = 1_000 + attempt * 11;
      const next = claimNextJob(db, 'test', {
        workerId: `dead-${attempt + 1}`, now: expiredAt, leaseMs: 10,
      });
      if (attempt < 3) expect(next?.attempts).toBe(attempt + 1);
      else expect(next).toBeNull();
    }
    expect(db.query('SELECT status, attempts FROM indexing_jobs_v2').get())
      .toEqual({ status: 'exhausted', attempts: 3 });
    expect(db.query('SELECT attempt_no, finished_at, outcome FROM indexing_job_attempts_v2 ORDER BY attempt_no').all())
      .toEqual([
        { attempt_no: 1, finished_at: 1011, outcome: 'lease_expired' },
        { attempt_no: 2, finished_at: 1022, outcome: 'lease_expired' },
        { attempt_no: 3, finished_at: 1033, outcome: 'exhausted' },
      ]);
  });

  it('reclaims only the requested model when leases expire together', () => {
    const db = queueDb();
    enqueueIndexJob(db, { docId: 'a', contentHash: HASH, modelKey: 'test', models: TEST_MODELS, now: 1 });
    enqueueIndexJob(db, { docId: 'b', contentHash: HASH, modelKey: 'other', models: TEST_MODELS, now: 1 });
    claimNextJob(db, 'test', { workerId: 'one', now: 10, leaseMs: 10 });
    claimNextJob(db, 'other', { workerId: 'two', now: 10, leaseMs: 10 });
    const reclaimed = claimNextJob(db, 'test', { workerId: 'three', now: 21, leaseMs: 10 });
    expect(reclaimed?.modelKey).toBe('test');
    expect(db.query(`SELECT status FROM indexing_jobs_v2 WHERE model_key = 'other'`).get())
      .toEqual({ status: 'claimed' });
  });

  it('claims requested-model pending work even when another model sorts first', () => {
    const db = queueDb();
    enqueueIndexJob(db, { docId: 'a', contentHash: HASH, modelKey: 'other', models: TEST_MODELS, now: 1 });
    enqueueIndexJob(db, { docId: 'z', contentHash: HASH, modelKey: 'test', models: TEST_MODELS, now: 2 });
    const claimed = claimNextJob(db, 'test', { workerId: 'test-only', now: 10 });
    expect(claimed?.modelKey).toBe('test');
    expect(db.query(`SELECT status FROM indexing_jobs_v2 WHERE model_key = 'other'`).get())
      .toEqual({ status: 'pending' });
  });
});

describe('v2 retry and cancellation', () => {
  it('moves transient failures to retry_wait with bounded delay', () => {
    const { db } = enqueue();
    const job = claimNextJob(db, 'test', { workerId: 'worker', now: 1_000, leaseMs: 100 })!;
    expect(retryClaim(db, job.id, job.claimToken!, 'temporary', 1_001)).toBe('retry_wait');
    const row = db.query<{ next_attempt_at: number; error: string }, []>(`
      SELECT next_attempt_at, error FROM indexing_jobs_v2
    `).get()!;
    expect(row.next_attempt_at).toBe(6_001);
    expect(row.error).toBe('temporary');
  });

  it('exhausts on the third failed claim without deleting attempts', () => {
    const { db } = enqueue();
    for (let attempt = 1; attempt <= 3; attempt++) {
      db.exec(`UPDATE indexing_jobs_v2 SET next_attempt_at = 0`);
      const job = claimNextJob(db, 'test', {
        workerId: 'worker', now: attempt * 1_000, leaseMs: 500,
      })!;
      const outcome = retryClaim(db, job.id, job.claimToken!, 'temporary', attempt * 1_000 + 1);
      expect(outcome).toBe(attempt === 3 ? 'exhausted' : 'retry_wait');
    }
    expect((db.query('SELECT COUNT(*) AS count FROM indexing_job_attempts_v2').get() as { count: number }).count)
      .toBe(3);
  });

  it('cancels eligible work but never rewrites done history', () => {
    const { db, job } = enqueue();
    expect(cancelJob(db, job.id, 'operator')).toBe(true);
    expect(cancelJob(db, job.id, 'again')).toBe(false);
    expect(jobsByStatus(db)[0]).toMatchObject({ status: 'cancelled', count: 1 });
  });

  it('requeues terminal work with a reason and preserves attempt history', () => {
    const { db, job } = enqueue();
    const claim = claimNextJob(db, 'test', { workerId: 'one', now: 1_001, leaseMs: 100 })!;
    finishClaim(db, job.id, claim.claimToken!, 'failed_permanent', 'bad', 1_002);
    expect(requeueTerminalJob(db, job.id, 'operator corrected provider', 1_003)).toBe(true);
    expect(db.query('SELECT status, attempts, error FROM indexing_jobs_v2').get()).toEqual({
      status: 'pending', attempts: 0, error: 'operator requeue: operator corrected provider',
    });
    const next = claimNextJob(db, 'test', { workerId: 'two', now: 1_004, leaseMs: 100 })!;
    expect(next.attempts).toBe(1);
    expect(db.query('SELECT attempt_no FROM indexing_job_attempts_v2 ORDER BY attempt_no').all())
      .toEqual([{ attempt_no: 1 }, { attempt_no: 2 }]);
    expect(db.query(`SELECT event_type, reason FROM indexing_job_events_v2`).get())
      .toEqual({ event_type: 'operator_requeue', reason: 'operator corrected provider' });
    expect(db.query(`SELECT error FROM indexing_jobs_v2`).get()).toEqual({ error: null });
  });

  for (const status of ['pending', 'claimed', 'retry_wait', 'done'] as const) {
    it(`requeue is a no-op for ${status} with history unchanged`, () => {
      const { db, job } = enqueue();
      if (status !== 'pending') {
        const claimed = claimNextJob(db, 'test', { workerId: 'one', now: 1_001, leaseMs: 100 })!;
        if (status === 'retry_wait') retryClaim(db, job.id, claimed.claimToken!, 'later', 1_002);
        if (status === 'done') finishClaim(db, job.id, claimed.claimToken!, 'done', null, 1_002);
      }
      const before = db.query(`SELECT * FROM indexing_jobs_v2 WHERE id = ?`).get(job.id);
      const attempts = db.query(`SELECT * FROM indexing_job_attempts_v2 ORDER BY id`).all();
      expect(requeueTerminalJob(db, job.id, 'must not append', 1_003)).toBe(false);
      expect(db.query(`SELECT * FROM indexing_jobs_v2 WHERE id = ?`).get(job.id)).toEqual(before);
      expect(db.query(`SELECT * FROM indexing_job_attempts_v2 ORDER BY id`).all()).toEqual(attempts);
      expect(db.query(`SELECT COUNT(*) AS n FROM indexing_job_events_v2`).get()).toEqual({ n: 0 });
    });
  }
});
