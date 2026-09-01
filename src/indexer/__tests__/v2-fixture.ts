import Database from 'bun:sqlite';
import type { QueueModel } from '../jobs.ts';

export const V2_QUEUE_SQL = (await Bun.file(
  `${import.meta.dir}/../../db/migrations/0017_durable_async_indexing_v2.sql`,
).text()).replaceAll('--> statement-breakpoint', '');

export const TEST_MODELS: Record<string, QueueModel> = {
  test: { collection: 'test_vectors', indexRevision: 'revision-test-1' },
  other: { collection: 'other_vectors', indexRevision: 'revision-other-1' },
};

export function queueDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(V2_QUEUE_SQL);
  db.exec('CREATE VIRTUAL TABLE oracle_fts USING fts5(id UNINDEXED, content, concepts)');
  return db;
}
