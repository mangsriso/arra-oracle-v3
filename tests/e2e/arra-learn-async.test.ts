import { afterEach, expect, it } from 'bun:test';
import { persistAsyncLearning } from '../../src/learn/persistence.ts';
import { learnHarness } from '../../src/learn/__tests__/fixture.ts';
import { makeDocumentLoader } from '../../src/indexer/source-loader.ts';
import { runWorker, type WorkerDeps } from '../../src/indexer/worker.ts';
import { LanceDBAdapter } from '../../src/vector/adapters/lancedb.ts';
import type { EmbeddingProvider } from '../../src/vector/types.ts';

class DeterministicEmbedder implements EmbeddingProvider {
  readonly name = 'deterministic-test';
  readonly dimensions = 3;
  readonly supportsAbort = true;
  calls: string[] = [];

  async embed(texts: string[], _type?: 'query' | 'passage', signal?: AbortSignal) {
    if (signal?.aborted) throw signal.reason;
    this.calls.push(...texts);
    return texts.map((text) => [text.length / 1000, 0.25, 0.75]);
  }
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function workerDeps(input: {
  h: Awaited<ReturnType<typeof learnHarness>>;
  store: LanceDBAdapter;
  embedder: DeterministicEmbedder;
  now: number;
  crashAfterUpsert?: boolean;
}): WorkerDeps {
  let checks = 0;
  return {
    db: input.h.db,
    workerId: `e2e-${crypto.randomUUID()}`,
    loadDocument: makeDocumentLoader({
      db: input.h.db, repoRoot: input.h.root, metadataSchemaVersion: 1,
    }),
    embed: async (_model, text, signal) => (await input.embedder.embed([text], 'passage', signal))[0],
    upsertVector: async (doc) => {
      await input.store.upsertDocuments([{
        id: doc.id, document: doc.text, metadata: doc.metadata, vector: doc.vector,
      }]);
      if (input.crashAfterUpsert) throw new Error('injected crash after Lance commit');
    },
    expectedDimension: () => 3,
    isShuttingDown: () => checks++ > 0,
    now: () => input.now,
    attemptTimeoutMs: 1_000,
    leaseMs: 2_000,
    heartbeatMs: 250,
    pollIntervalMs: 1,
  };
}

it('real temporary file/SQLite/FTS/Lance flow survives crash-after-upsert without duplicates', async () => {
  const h = await learnHarness();
  cleanups.push(h.cleanup);
  const learned = await persistAsyncLearning(h.deps, {
    pattern: 'authoritative durable learning\nwith exact metadata',
    concepts: ['e2e', 'durability'],
    source: 'hermetic test',
    project: 'github.com/example/e2e',
  });
  expect(learned.success).toBe(true);

  const embedder = new DeterministicEmbedder();
  const lancePath = `${h.root}/lance`;
  let store = new LanceDBAdapter('learn_test_vectors', lancePath, embedder);
  await store.connect();
  await store.ensureCollection();
  await runWorker('test', workerDeps({
    h, store, embedder, now: Date.now(), crashAfterUpsert: true,
  }));
  expect((h.db.query('SELECT status FROM indexing_jobs_v2').get() as { status: string }).status)
    .toBe('retry_wait');
  await store.close();

  h.db.exec('UPDATE indexing_jobs_v2 SET next_attempt_at = 0');
  store = new LanceDBAdapter('learn_test_vectors', lancePath, embedder);
  cleanups.push(() => store.close());
  await store.connect();
  await store.ensureCollection();
  await runWorker('test', workerDeps({ h, store, embedder, now: Date.now() + 10_000 }));

  const rows = await store.getDocumentTexts();
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe(learned.id);
  expect(rows[0].text).toBe(await Bun.file(`${h.root}/${learned.file}`).text());
  const stored = await store.getAllEmbeddings();
  expect(stored.ids).toEqual([learned.id]);
  expect(stored.metadatas[0]).toMatchObject({
    type: 'learning',
    source_file: learned.file,
    content_hash: learned.durability.content_hash,
    index_revision: learned.indexing.index_revision,
    metadata_schema_version: 1,
  });
  expect((h.db.query('SELECT status FROM indexing_jobs_v2').get() as { status: string }).status)
    .toBe('done');
  expect(embedder.calls).toHaveLength(2);
}, 20_000);
