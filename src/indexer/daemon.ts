import { Elysia } from 'elysia';
import { DB_PATH, LANCEDB_DIR, REPO_ROOT } from '../config.ts';
import { getEmbeddingModels } from '../vector/factory.ts';
import { createEmbeddingProvider } from '../vector/embeddings.ts';
import { resolveEmbeddingRuntime } from '../vector/runtime-config.ts';
import { resolveAsyncIndexerConfig } from '../vector/indexer-config.ts';
import { LanceDBAdapter } from '../vector/adapters/lancedb.ts';
import { runWorker, type WorkerEvent } from './worker.ts';
import { makeDocumentLoader } from './source-loader.ts';
import { daemonApiPlugin, makeEventBus } from '../routes/indexer-daemon/index.ts';
import { getVaultPsiRoot } from '../vault/discovery.ts';
import { createDatabase } from '../db/index.ts';

interface IndexerOwnerLock { release(): void }

const PORT = Number.parseInt(process.env.INDEXER_PORT || '47779', 10);
const HOST = process.env.INDEXER_HOST || '127.0.0.1';

export async function startDaemon(): Promise<void> {
  const models = getEmbeddingModels();
  const runtime = resolveAsyncIndexerConfig(models);
  const { sqlite: db } = createDatabase(DB_PATH);
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const eventBus = makeEventBus<WorkerEvent>();
  let shuttingDown = false;
  const workerPromises: Promise<unknown>[] = [];
  const stores: LanceDBAdapter[] = [];
  const shutdownSignal = new AbortController();
  let livenessError: string | null = null;
  let ownerLock: IndexerOwnerLock | null = null;

  const activeModels = (runtime.producerEnabled || runtime.workersEnabled) && runtime.modelKey
    ? {
        [runtime.modelKey]: {
          collection: runtime.collection!,
          indexRevision: runtime.indexRevision!,
        },
      }
    : {};

  if (runtime.workersEnabled) {
    const { acquireIndexerOwnerLock } = await import('./owner-lock.ts');
    ownerLock = acquireIndexerOwnerLock(`${DB_PATH}.arra-indexer.lock`);
    const modelKey = runtime.modelKey!;
    const preset = models[modelKey];
    const identity = resolveEmbeddingRuntime(preset);
    const embedder = createEmbeddingProvider(identity.provider, identity.model);
    if (!embedder.supportsAbort) {
      throw new Error(`Embedding provider does not support cancellation: ${identity.provider}`);
    }
    const probe = new AbortController();
    const probeTimer = setTimeout(() => probe.abort(new Error('Embedding readiness probe timed out')), 10_000);
    let probeVector: number[];
    try {
      [probeVector] = await embedder.embed(['arra indexer dimension readiness probe'], 'passage', probe.signal);
    } finally {
      clearTimeout(probeTimer);
    }
    if (!probeVector! || probeVector.length !== preset.dimension || !probeVector.every(Number.isFinite)) {
      throw new Error(
        `Embedding dimension mismatch for ${modelKey}: registry=${preset.dimension}, provider=${probeVector?.length ?? 0}`,
      );
    }
    const store = new LanceDBAdapter(preset.collection, preset.dataPath || LANCEDB_DIR, embedder);
    if (typeof store.upsertDocuments !== 'function') {
      throw new Error('Configured vector adapter does not support keyed upsert');
    }
    await store.connect();
    await store.ensureCollection(preset.dimension);
    stores.push(store);
    const vault = getVaultPsiRoot();
    const loadDocument = makeDocumentLoader({
      db, repoRoot: REPO_ROOT, vaultRoot: 'path' in vault ? vault.path : null,
      metadataSchemaVersion: preset.metadataSchemaVersion,
    });
    const workerId = `arra-indexer:${process.pid}:${crypto.randomUUID()}`;
    workerPromises.push(runWorker(modelKey, {
      db,
      workerId,
      loadDocument,
      embed: async (_key, text, signal) => {
        const [vector] = await embedder.embed([text], 'passage', signal);
        return vector;
      },
      upsertVector: async (input) => store.upsertDocuments([{
        id: input.id, document: input.text, metadata: input.metadata, vector: input.vector,
      }]),
      expectedDimension: () => preset.dimension,
      isShuttingDown: () => shuttingDown,
      shutdownSignal: shutdownSignal.signal,
      onEvent: eventBus.publish,
      onUnsafeTimeout: (_job, phase) => {
        livenessError = `unsafe external operation timeout: ${phase}`;
        shuttingDown = true;
        setTimeout(() => process.exit(70), 0);
      },
    }).catch((error) => {
      livenessError = error instanceof Error ? error.message : String(error);
      shuttingDown = true;
      setTimeout(() => process.exit(70), 0);
    }));
  }

  const app = new Elysia()
    .onError(({ error, set }) => {
      set.status = 500;
      return { error: error instanceof Error ? error.message : String(error) };
    })
    .use(daemonApiPlugin({
      db,
      models: activeModels,
      producerEnabled: runtime.producerEnabled,
      workersEnabled: runtime.workersEnabled,
      activeModelKey: runtime.modelKey,
      indexRevision: runtime.indexRevision,
      collection: runtime.collection,
      dimension: runtime.dimension,
      livenessError: () => livenessError,
      isShuttingDown: () => shuttingDown,
      requestShutdown: () => { shuttingDown = true; },
      subscribe: eventBus.subscribe,
    }))
    .listen({ hostname: HOST, port: PORT });

  const shutdown = async (signal: string) => {
    console.log(`[arra-indexer] ${signal} — draining…`);
    shuttingDown = true;
    shutdownSignal.abort(new Error(signal));
    await app.stop();
    const shutdownMs = Number.parseInt(process.env.INDEXER_SHUTDOWN_TIMEOUT_MS || '70000', 10);
    const drained = await Promise.race([
      Promise.all(workerPromises).then(() => true), Bun.sleep(shutdownMs).then(() => false),
    ]);
    if (!drained) process.exit(70);
    await Promise.all(stores.map((store) => store.close()));
    ownerLock?.release();
    db.close();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM').then(() => process.exit(0)));
  process.on('SIGINT', () => void shutdown('SIGINT').then(() => process.exit(0)));
  console.log(`[arra-indexer] listening on http://${HOST}:${PORT}`);
}

if (import.meta.main) {
  startDaemon().catch((error) => {
    console.error('[arra-indexer] fatal:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
