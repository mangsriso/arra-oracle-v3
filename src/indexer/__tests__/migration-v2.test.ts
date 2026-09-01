import { describe, expect, it } from 'bun:test';
import Database from 'bun:sqlite';
import { repairPartialA2Schema } from '../../db/a2-compat.ts';

async function applyMigration(db: Database) {
  const sql = await Bun.file(
    `${import.meta.dir}/../../db/migrations/0017_durable_async_indexing_v2.sql`,
  ).text();
  db.exec(sql.replaceAll('--> statement-breakpoint', ''));
}

describe('0017 durable async indexing migration', () => {
  it('repairs an early partial 0017 without rewriting existing jobs', () => {
    const db = new Database(':memory:');
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE indexing_jobs_v2 (
        id TEXT PRIMARY KEY NOT NULL,
        doc_id TEXT NOT NULL,
        status TEXT NOT NULL,
        cancellation_requested_at INTEGER
      );
      INSERT INTO indexing_jobs_v2
        (id, doc_id, status, cancellation_requested_at)
      VALUES ('preserved', 'doc', 'pending', 42);
    `);

    repairPartialA2Schema(db);
    repairPartialA2Schema(db);

    const columns = db.query<{ name: string }, []>('PRAGMA table_info(indexing_jobs_v2)')
      .all().map((row) => row.name);
    expect(columns).toContain('external_write_started_at');
    expect(columns).toContain('cancellation_too_late_at');
    expect(db.query('SELECT id, doc_id, status, cancellation_requested_at FROM indexing_jobs_v2').get())
      .toEqual({ id: 'preserved', doc_id: 'doc', status: 'pending', cancellation_requested_at: 42 });
    expect(db.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'indexing_job_events_v2'",
    ).get()).toEqual({ name: 'indexing_job_events_v2' });
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  it('keeps the event table in Drizzle schema/filter parity', async () => {
    const config = await Bun.file(`${import.meta.dir}/../../../drizzle.config.ts`).text();
    const schema = await Bun.file(`${import.meta.dir}/../../db/schema-a2.ts`).text();
    expect(config).toContain("'indexing_job_events_v2'");
    expect(schema).toContain("sqliteTable('indexing_job_events_v2'");
  });
  it('creates v2 tables without mutating preserved legacy rows', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE indexing_jobs (id TEXT PRIMARY KEY, status TEXT); INSERT INTO indexing_jobs VALUES (\'legacy\', \'error\')');
    await applyMigration(db);
    expect((db.query('SELECT status FROM indexing_jobs WHERE id = \'legacy\'').get() as { status: string }).status)
      .toBe('error');
    const tables = db.query<{ name: string }, []>(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_v2' ORDER BY name
    `).all().map((row) => row.name);
    expect(tables).toEqual([
      'indexing_job_attempts_v2', 'indexing_job_events_v2',
      'indexing_jobs_v2', 'learn_reservations_v2',
    ]);
    db.close();
  });

  it('enforces one logical job and one attempt number', async () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    await applyMigration(db);
    const insertJob = db.prepare(`
      INSERT INTO indexing_jobs_v2
        (id, doc_id, model_key, collection, content_hash, index_revision,
         status, attempts, created_at, next_attempt_at)
      VALUES (?, 'doc', 'model', 'collection', 'hash', 'revision', 'pending', 0, 1, 1)
    `);
    insertJob.run('one');
    expect(() => insertJob.run('two')).toThrow('UNIQUE constraint failed');
    const attempt = db.prepare(`
      INSERT INTO indexing_job_attempts_v2
        (job_id, attempt_no, started_at, outcome) VALUES ('one', 1, 1, 'claimed')
    `);
    attempt.run();
    expect(() => attempt.run()).toThrow('UNIQUE constraint failed');
    expect(() => db.exec(`
      INSERT INTO indexing_job_attempts_v2
        (job_id, attempt_no, started_at, outcome) VALUES ('missing', 1, 1, 'claimed')
    `)).toThrow('FOREIGN KEY constraint failed');
    expect(() => db.exec(`
      INSERT INTO indexing_job_events_v2 (job_id, event_type, reason, created_at)
      VALUES ('missing', 'operator_requeue', 'reason', 1)
    `)).toThrow('FOREIGN KEY constraint failed');
    expect(() => db.exec(`
      UPDATE indexing_jobs_v2 SET status = 'unknown' WHERE id = 'one'
    `)).toThrow('CHECK constraint failed');
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  it('reopens a migrated file with foreign keys intact and no violations', async () => {
    const made = Bun.spawnSync(['mktemp', '-d', '/tmp/arra-migration.XXXXXX']);
    const root = new TextDecoder().decode(made.stdout).trim();
    const path = `${root}/oracle.db`;
    try {
      const first = new Database(path);
      first.exec('PRAGMA foreign_keys = ON');
      await applyMigration(first);
      first.close();
      const reopened = new Database(path);
      reopened.exec('PRAGMA foreign_keys = ON');
      expect(reopened.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys)
        .toBe(1);
      expect(reopened.query('PRAGMA foreign_key_check').all()).toEqual([]);
      reopened.close();
    } finally {
      Bun.spawnSync(['rm', '-r', '--', root]);
    }
  });
});
