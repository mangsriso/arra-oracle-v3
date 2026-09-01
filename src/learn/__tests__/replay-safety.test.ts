import { afterEach, describe, expect, it } from 'bun:test';
import Database from 'bun:sqlite';
import { persistAsyncLearning } from '../persistence.ts';
import { learnHarness } from './fixture.ts';
import { reserveLearning } from '../reservations.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

async function harness() {
  const value = await learnHarness();
  cleanups.push(value.cleanup);
  return value;
}

describe('async learn replay safety', () => {
  for (const status of [
    'failed_permanent', 'exhausted', 'cancelled', 'skipped_missing',
    'superseded', 'blocked_projection',
  ]) {
    it(`returns degraded with exact terminal status ${status}`, async () => {
      const h = await harness();
      const input = { pattern: `terminal replay ${status}` };
      const first = await persistAsyncLearning(h.deps, input);
      h.db.prepare('UPDATE indexing_jobs_v2 SET status = ?, finished_at = ? WHERE id = ?')
        .run(status, Date.now(), first.indexing.job_id);
      const replay = await persistAsyncLearning(h.deps, input);
      expect(replay.success).toBe(false);
      expect(replay.outcome).toBe('degraded');
      expect(replay.indexing.status).toBe(status);
      expect(replay.indexing.job_id).toBe(first.indexing.job_id);
      expect(replay.error).toContain('explicitly requeue');
    });
  }

  for (const damage of ['missing', 'corrupt'] as const) {
    it(`does not claim full terminal durability when the canonical file is ${damage}`, async () => {
      const h = await harness();
      const input = { pattern: `terminal file ${damage}` };
      const first = await persistAsyncLearning(h.deps, input);
      h.db.prepare(`UPDATE indexing_jobs_v2 SET status = 'exhausted' WHERE id = ?`)
        .run(first.indexing.job_id);
      const physical = `${h.deps.learningDir}/${first.file.split('/').at(-1)}`;
      if (damage === 'missing') await Bun.file(physical).delete();
      else await Bun.write(physical, 'corrupt');
      const replay = await persistAsyncLearning(h.deps, input);
      expect(replay.outcome).toBe('degraded');
      expect(replay.durability.level).toBe('missing');
      expect(replay.error).toContain('missing or corrupt');
    });
  }

  it('rejects in-memory SQLite before any reservation', async () => {
    const h = await harness();
    const memory = new Database(':memory:');
    memory.exec('PRAGMA synchronous = FULL');
    try {
      await expect(persistAsyncLearning({ ...h.deps, sqlite: memory }, { pattern: 'memory' }))
        .rejects.toThrow('file-backed');
    } finally {
      memory.close();
    }
  });

  it('rejects the environment-selected non-abortable provider before mutation', async () => {
    const h = await harness();
    await expect(persistAsyncLearning({
      ...h.deps,
      env: { ...h.deps.env, ORACLE_EMBEDDING_PROVIDER: 'chromadb-internal' },
    }, { pattern: 'provider capability tripwire' })).rejects.toThrow('does not support cancellation');
    expect((h.db.query('SELECT COUNT(*) AS n FROM learn_reservations_v2').get() as { n: number }).n)
      .toBe(0);
    expect(await Bun.file(h.deps.learningDir).exists()).toBe(false);
  });

  it('returns structured partial and releases ownership after a lost publication fence', async () => {
    const h = await harness();
    const result = await persistAsyncLearning({
      ...h.deps,
      faults: {
        afterFilePublish: () => h.db.exec(`
          UPDATE learn_reservations_v2
          SET generation = generation + 1, owner_token = NULL, lease_until = 0
        `),
      },
    }, { pattern: 'lost publication fence' });
    expect(result).toMatchObject({ success: false, outcome: 'partial', embedding: 'failed' });
    expect(result.error).toContain('fence was lost');
    expect(h.db.query('SELECT owner_token, lease_until FROM learn_reservations_v2').get())
      .toEqual({ owner_token: null, lease_until: 0 });
  });

  it('never finalizes after a slow publication loses its reservation lease', async () => {
    const h = await harness();
    const result = await persistAsyncLearning({
      ...h.deps,
      faults: {
        afterLink: () => h.db.exec(`
          UPDATE learn_reservations_v2
          SET generation = generation + 1, owner_token = 'takeover', lease_until = 9999999999999
        `),
      },
    }, { pattern: 'slow publication takeover' });
    expect(result).toMatchObject({ outcome: 'partial', success: false });
    expect(result.error).toContain('fence was lost');
    expect(h.db.query('SELECT COUNT(*) AS n FROM oracle_documents').get()).toEqual({ n: 0 });
    expect(h.db.query('SELECT generation, owner_token FROM learn_reservations_v2').get())
      .toEqual({ generation: 2, owner_token: 'takeover' });
    const entries = Array.from(new Bun.Glob('*').scanSync({ cwd: h.deps.learningDir }));
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('renews throughout a sync longer than the original lease and excludes a competitor', async () => {
    const h = await harness();
    let enter!: () => void;
    let delayed = false;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const running = persistAsyncLearning({
      ...h.deps, reservationLeaseMs: 500,
      faults: {
        syncOperation: async () => {
          if (delayed) return;
          delayed = true;
          enter();
          await Bun.sleep(1_200);
        },
      },
    }, { pattern: 'heartbeat during deliberately slow fsync' });
    await entered;
    const original = h.db.query<any, []>('SELECT * FROM learn_reservations_v2').get();
    await Bun.sleep(700);
    const renewed = h.db.query<any, []>('SELECT * FROM learn_reservations_v2').get();
    expect(renewed.lease_until).toBeGreaterThan(original.lease_until);
    const competitor = reserveLearning(h.db, {
      fingerprint: renewed.request_fingerprint,
      idempotencyKeyHash: renewed.idempotency_key_hash,
      docId: renewed.doc_id, sourceFile: renewed.source_file,
      storageRoot: renewed.storage_root, createdAt: renewed.created_at,
      ownerToken: 'competitor', now: Date.now(), leaseMs: 500,
    });
    expect(competitor.kind).toBe('busy');
    expect((await running).outcome).toBe('created');
  });

  it('serializes concurrent initial creation across WAL connections', async () => {
    const h = await harness();
    const second = new Database(`${h.root}/oracle.db`);
    second.exec('PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000');
    try {
      const input = { pattern: 'concurrent initial creation' };
      const [left, right] = await Promise.all([
        persistAsyncLearning(h.deps, input),
        persistAsyncLearning({ ...h.deps, sqlite: second }, input),
      ]);
      expect([left.outcome, right.outcome].sort()).toEqual(['created', 'replayed']);
      for (const table of ['learn_reservations_v2', 'oracle_documents', 'oracle_fts', 'indexing_jobs_v2']) {
        expect((h.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(1);
      }
      const files = Array.from(new Bun.Glob('*.md').scanSync({ cwd: h.deps.learningDir }));
      expect(files).toHaveLength(1);
    } finally {
      second.close();
    }
  });
});
