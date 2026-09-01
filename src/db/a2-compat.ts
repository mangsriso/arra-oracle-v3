import type Database from 'bun:sqlite';

function tableExists(db: Database, name: string): boolean {
  return db.query<{ ok: number }, [string]>(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name)?.ok === 1;
}

/**
 * Repair hosts that recorded an early 0017 draft before its final columns and
 * event table landed. Existing rows are preserved; fresh databases remain
 * owned entirely by the normal Drizzle migration sequence.
 */
export function repairPartialA2Schema(db: Database): void {
  if (!tableExists(db, 'indexing_jobs_v2')) return;

  const columns = new Set(
    db.query<{ name: string }, []>('PRAGMA table_info(indexing_jobs_v2)')
      .all()
      .map((row) => row.name),
  );
  if (!columns.has('external_write_started_at')) {
    db.exec('ALTER TABLE indexing_jobs_v2 ADD COLUMN external_write_started_at INTEGER');
  }
  if (!columns.has('cancellation_too_late_at')) {
    db.exec('ALTER TABLE indexing_jobs_v2 ADD COLUMN cancellation_too_late_at INTEGER');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS indexing_job_events_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      job_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (job_id) REFERENCES indexing_jobs_v2(id)
    );
    CREATE INDEX IF NOT EXISTS idx_indexing_job_events_v2_job
      ON indexing_job_events_v2 (job_id, created_at, id);
  `);
}
