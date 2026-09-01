import Database from 'bun:sqlite';
import { runWorker } from '../../../src/indexer/worker.ts';
import { makeDocumentLoader } from '../../../src/indexer/source-loader.ts';
import { LanceDBAdapter } from '../../../src/vector/adapters/lancedb.ts';
import { assertSafeTestRuntime } from '../../../src/testing/test-safety.ts';
import type { EmbeddingProvider } from '../../../src/vector/types.ts';

class DeterministicEmbedder implements EmbeddingProvider {
  readonly name = 'a2-child-test';
  readonly dimensions = 3;
  readonly supportsAbort = true;

  async embed(texts: string[], _type?: 'query' | 'passage', signal?: AbortSignal) {
    if (signal?.aborted) throw signal.reason;
    return texts.map((text) => [text.length / 1000, 0.25, 0.75]);
  }
}

assertSafeTestRuntime();
const mode = process.env.A2_WORKER_MODE;
const lancePath = process.env.A2_LANCE_PATH;
const dbPath = process.env.ORACLE_DB_PATH;
const repoRoot = process.env.ORACLE_REPO_ROOT;
if (!mode || !lancePath || !dbPath || !repoRoot) throw new Error('worker fixture env is incomplete');

const db = new Database(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON');
const embedder = new DeterministicEmbedder();
const store = new LanceDBAdapter('learn_test_vectors', lancePath, embedder);
await store.connect();
await store.ensureCollection();
let finished = false;

await runWorker('test', {
  db,
  workerId: `a2-child-${mode}-${process.pid}`,
  loadDocument: makeDocumentLoader({ db, repoRoot, metadataSchemaVersion: 1 }),
  embed: async (_key, text, signal) => (await embedder.embed([text], 'passage', signal))[0],
  upsertVector: async (document) => {
    if (mode === 'hang') await new Promise<void>(() => {});
    await store.upsertDocuments([{
      id: document.id,
      document: document.text,
      metadata: document.metadata,
      vector: document.vector,
    }]);
    if (mode === 'crash') process.kill(process.pid, 'SIGKILL');
  },
  expectedDimension: () => 3,
  isShuttingDown: () => finished,
  onEvent: (event) => {
    if (event.type === 'done' || event.type === 'terminal' || event.type === 'stale') {
      finished = true;
    }
  },
  pollIntervalMs: 1,
  attemptTimeoutMs: 250,
  leaseMs: 500,
  heartbeatMs: 100,
  onUnsafeTimeout: () => process.exit(70),
});

await store.close();
db.close();
