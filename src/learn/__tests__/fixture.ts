import Database from 'bun:sqlite';
import type { EmbeddingModelPreset } from '../../vector/config.ts';

export const TEST_MODELS: Record<string, EmbeddingModelPreset> = {
  test: {
    collection: 'learn_test_vectors', model: 'test-embedder', provider: 'ollama',
    dimension: 3, metadataSchemaVersion: 1, supportsAbort: true,
    supportsPrecomputedUpsert: true, dataPath: '/isolated/test-vectors',
  },
};

export const TEST_ENV = {
  ORACLE_INDEXER_ENQUEUE: '1',
  ORACLE_INDEXER_WORKERS_ENABLED: '0',
  ORACLE_EMBEDDING_MODEL_KEY: 'test',
  ORACLE_EMBEDDING_DEPLOYMENT_REVISION: 'hermetic-test-1',
};

export async function learnHarness() {
  const temp = Bun.spawnSync(['mktemp', '-d', '/tmp/arra-learn-a2.XXXXXX']);
  if (temp.exitCode !== 0) throw new Error('mktemp failed');
  const root = temp.stdout.toString().trim();
  const db = new Database(`${root}/oracle.db`);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE oracle_documents (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, source_file TEXT NOT NULL,
      concepts TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL, superseded_by TEXT, superseded_at INTEGER,
      superseded_reason TEXT, origin TEXT, project TEXT, created_by TEXT
    );
    CREATE VIRTUAL TABLE oracle_fts USING fts5(id UNINDEXED, content, concepts);
  `);
  const migration = await Bun.file(
    `${import.meta.dir}/../../db/migrations/0017_durable_async_indexing_v2.sql`,
  ).text();
  db.exec(migration.replaceAll('--> statement-breakpoint', ''));
  return {
    root,
    db,
    deps: {
      sqlite: db,
      learningDir: `${root}/ψ/memory/learnings`,
      sourceFilePrefix: 'ψ/memory/learnings',
      models: TEST_MODELS,
      env: TEST_ENV,
    },
    cleanup() {
      db.close();
      Bun.spawnSync(['rm', '-r', '--', root], { stdout: 'ignore', stderr: 'ignore' });
    },
  };
}
