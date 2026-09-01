import { afterEach, describe, expect, it } from 'bun:test';
import Database from 'bun:sqlite';
import { persistAsyncLearning, LearnConflictError } from '../persistence.ts';
import { canonicalizeLearnRequest, documentIdentity, renderLearning, requestFingerprint } from '../canonical.ts';
import { learnHarness } from './fixture.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

async function harness() {
  const value = await learnHarness();
  cleanups.push(value.cleanup);
  return value;
}

describe('durable async learning persistence', () => {
  it('creates one durable identity/projection/job and cross-midnight replay is duplicate-free', async () => {
    const h = await harness();
    let now = Date.parse('2026-08-31T23:59:59.999Z');
    const deps = { ...h.deps, now: () => now };
    const input = {
      pattern: 'คิวแบบทนทาน\r\nสำหรับ Unicode',
      concepts: ['queue', 'ไทย', 'queue'],
      project: 'github.com/example/repo',
    };
    const first = await persistAsyncLearning(deps, input);
    now = Date.parse('2026-09-01T00:00:01.000Z');
    const replay = await persistAsyncLearning(deps, input);
    expect(first.outcome).toBe('created');
    expect(replay.outcome).toBe('replayed');
    expect(replay.id).toBe(first.id);
    expect(replay.file).toBe(first.file);
    for (const table of ['learn_reservations_v2', 'oracle_documents', 'oracle_fts', 'indexing_jobs_v2']) {
      const count = h.db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()!;
      expect(count.count).toBe(1);
    }
    expect(first.embedding).toBe('enqueued');
  });

  it('preserves a published file as partial and identical retry reconciles projections/job', async () => {
    const h = await harness();
    let fail = true;
    const deps = {
      ...h.deps,
      faults: { afterPublish: () => { if (fail) { fail = false; throw new Error('injected DB outage'); } } },
    };
    const input = { pattern: 'publication split recovery' };
    const partial = await persistAsyncLearning(deps, input);
    expect(partial.outcome).toBe('partial');
    expect(partial.durability.level).toBe('file');
    expect(await Bun.file(`${h.root}/${partial.file}`).exists()).toBe(true);
    expect((h.db.query('SELECT COUNT(*) AS count FROM oracle_documents').get() as { count: number }).count)
      .toBe(0);
    const repaired = await persistAsyncLearning(deps, input);
    expect(repaired.outcome).toBe('reconciled');
    expect((h.db.query('SELECT COUNT(*) AS count FROM indexing_jobs_v2').get() as { count: number }).count)
      .toBe(1);
  });

  it('hard-conflicts idempotency-key reuse with different canonical content', async () => {
    const h = await harness();
    await persistAsyncLearning(h.deps, { pattern: 'first', idempotencyKey: 'retry-key' });
    await expect(persistAsyncLearning(h.deps, {
      pattern: 'second', idempotencyKey: 'retry-key',
    })).rejects.toBeInstanceOf(LearnConflictError);
    expect((h.db.query('SELECT COUNT(*) AS count FROM oracle_documents').get() as { count: number }).count)
      .toBe(1);
  });

  it('binds a retry key added after an unkeyed canonical request', async () => {
    const h = await harness();
    await persistAsyncLearning(h.deps, { pattern: 'first unkeyed' });
    await persistAsyncLearning(h.deps, { pattern: 'first unkeyed', idempotencyKey: 'late-key' });
    await expect(persistAsyncLearning(h.deps, {
      pattern: 'different content', idempotencyKey: 'late-key',
    })).rejects.toBeInstanceOf(LearnConflictError);
  });

  it('invalid enabled runtime fails before reservation or file mutation', async () => {
    const h = await harness();
    const invalid = { ...h.deps, env: { ORACLE_INDEXER_ENQUEUE: '1' } };
    await expect(persistAsyncLearning(invalid, { pattern: 'must not persist' }))
      .rejects.toThrow('ORACLE_EMBEDDING_MODEL_KEY');
    expect((h.db.query('SELECT COUNT(*) AS count FROM learn_reservations_v2').get() as { count: number }).count)
      .toBe(0);
    expect(await Bun.file(`${h.root}/ψ/memory/learnings`).exists()).toBe(false);
  });

  it('keeps the reserved storage root across transport placement changes', async () => {
    for (const reverse of [false, true]) {
      const h = await harness();
      const vault = `${h.root}/vault/learnings`;
      const repo = `${h.root}/repo/learnings`;
      const firstRoot = reverse ? repo : vault;
      const secondRoot = reverse ? vault : repo;
      const input = { pattern: `placement-${reverse}` };
      const first = await persistAsyncLearning({ ...h.deps, learningDir: firstRoot }, input);
      const second = await persistAsyncLearning({ ...h.deps, learningDir: secondRoot }, input);
      expect([first.outcome, second.outcome]).toEqual(['created', 'replayed']);
      const filename = first.file.split('/').at(-1)!;
      expect(await Bun.file(`${firstRoot}/${filename}`).exists()).toBe(true);
      expect(await Bun.file(`${secondRoot}/${filename}`).exists()).toBe(false);
      const reservation = h.db.query('SELECT storage_root FROM learn_reservations_v2').get();
      expect(reservation).toEqual({ storage_root: firstRoot });
    }
  });

  it('creates a distinct logical job when the index revision changes', async () => {
    const h = await harness();
    const input = { pattern: 'revision migration' };
    const first = await persistAsyncLearning(h.deps, input);
    const second = await persistAsyncLearning({
      ...h.deps,
      env: { ...h.deps.env, ORACLE_EMBEDDING_DEPLOYMENT_REVISION: 'hermetic-test-2' },
    }, input);
    expect(second.outcome).toBe('reconciled');
    expect(second.indexing.job_id).not.toBe(first.indexing.job_id);
    expect(h.db.query('SELECT index_revision FROM indexing_jobs_v2 ORDER BY created_at, id').all())
      .toHaveLength(2);
  });

  it('conflicts on immutable projection corruption without repairing bytes', async () => {
    const h = await harness();
    const input = { pattern: 'repair exact projection', project: 'github.com/example/repo' };
    const first = await persistAsyncLearning(h.deps, input);
    h.db.prepare(`UPDATE oracle_documents SET project = 'corrupt', created_by = 'other' WHERE id = ?`)
      .run(first.id);
    h.db.prepare(`
      UPDATE indexing_jobs_v2 SET collection = 'corrupt', model_key = 'wrong',
        content_hash = 'wrong', index_revision = 'wrong' WHERE doc_id = ?
    `).run(first.id);
    await expect(persistAsyncLearning(h.deps, input)).rejects.toBeInstanceOf(LearnConflictError);
    expect(h.db.query('SELECT project, created_by FROM oracle_documents WHERE id = ?').get(first.id))
      .toEqual({ project: 'corrupt', created_by: 'other' });
    expect(h.db.query(`
      SELECT collection, model_key, content_hash, index_revision FROM indexing_jobs_v2 WHERE doc_id = ?
    `).get(first.id)).toEqual({
      collection: 'corrupt', model_key: 'wrong', content_hash: 'wrong', index_revision: 'wrong',
    });
  });

  for (const target of ['fts', 'job'] as const) {
    it(`conflicts on ${target} corruption and preserves the corrupt evidence`, async () => {
      const h = await harness();
      const input = { pattern: `preserve ${target} corruption` };
      const first = await persistAsyncLearning(h.deps, input);
      if (target === 'fts') {
        h.db.prepare(`UPDATE oracle_fts SET content = 'corrupt evidence' WHERE id = ?`).run(first.id);
      } else {
        h.db.prepare(`UPDATE indexing_jobs_v2 SET model_key = 'corrupt-model' WHERE id = ?`)
          .run(first.indexing.job_id);
      }
      await expect(persistAsyncLearning(h.deps, input)).rejects.toBeInstanceOf(LearnConflictError);
      const evidence = target === 'fts'
        ? h.db.query('SELECT content FROM oracle_fts WHERE id = ?').get(first.id)
        : h.db.query('SELECT model_key FROM indexing_jobs_v2 WHERE id = ?').get(first.indexing.job_id!);
      expect(evidence).toEqual(target === 'fts'
        ? { content: 'corrupt evidence' } : { model_key: 'corrupt-model' });
    });
  }

  it('serializes concurrent reconcilers across SQLite connections with CAS', async () => {
    const h = await harness();
    const input = { pattern: 'concurrent repair' };
    const first = await persistAsyncLearning(h.deps, input);
    h.db.prepare(`DELETE FROM oracle_fts WHERE id = ?`).run(first.id);
    const secondDb = new Database(`${h.root}/oracle.db`);
    secondDb.exec('PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000');
    try {
      const [left, right] = await Promise.all([
        persistAsyncLearning(h.deps, input),
        persistAsyncLearning({ ...h.deps, sqlite: secondDb }, input),
      ]);
      expect([left.outcome, right.outcome].sort()).toEqual(['reconciled', 'replayed']);
      expect((h.db.query('SELECT COUNT(*) AS n FROM oracle_fts').get() as { n: number }).n).toBe(1);
    } finally {
      secondDb.close();
    }
  });

  it('never replaces a conflicting deterministic final path', async () => {
    const h = await harness();
    const input = { pattern: 'conflict path' };
    const canonical = canonicalizeLearnRequest(input);
    const fingerprint = requestFingerprint(canonical);
    const createdAt = Date.now();
    const identity = documentIdentity(canonical, fingerprint, createdAt);
    const directory = `${h.root}/ψ/memory/learnings`;
    Bun.spawnSync(['mkdir', '-p', '--', directory]);
    await Bun.write(`${directory}/${identity.filename}`, 'unrelated bytes');
    await expect(persistAsyncLearning({ ...h.deps, now: () => createdAt }, input))
      .rejects.toThrow('conflict');
    expect(await Bun.file(`${directory}/${identity.filename}`).text()).toBe('unrelated bytes');
    expect(renderLearning(canonical, fingerprint, createdAt)).not.toBe('unrelated bytes');
  });
});
