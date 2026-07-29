import { Elysia, t } from 'elysia';
import { createVectorStore, getEmbeddingModels } from '../../vector/factory.ts';
import { createDatabase } from '../../db/index.ts';
import { setIndexingStatus } from '../../indexer/status.ts';
import { DB_PATH, REPO_ROOT } from '../../config.ts';
import type { IndexerConfig } from '../../types.ts';
import { resolveEmbeddingRuntime } from '../../vector/runtime-config.ts';
import {
  isReindexConfirmed,
  isValidReindexBatchSize,
  REINDEX_CONFIRMATION,
} from '../../vector/reindex-guard.ts';

let abortFlag = false;
let indexerRunning = false;
export function getAbortFlag() { return abortFlag; }
export function setAbortFlag(v: boolean) { abortFlag = v; }
export function getIndexerRunning() { return indexerRunning; }

export const startEndpoint = new Elysia().post('/indexer/start', async ({ body, set }) => {
  if (!isReindexConfirmed(body.confirmation)) {
    set.status = 400;
    return {
      error: 'Vector reindex requires exact destructive-operation confirmation',
      requiredConfirmation: REINDEX_CONFIRMATION,
    };
  }
  if (indexerRunning) {
    set.status = 409;
    return { error: 'Indexing already in progress' };
  }
  const { model, sourcePath, batchSize } = body;

  const models = getEmbeddingModels();
  if (model && !models[model]) {
    set.status = 400;
    return { error: `Unknown embedding model: ${model}` };
  }
  if (batchSize !== undefined && !isValidReindexBatchSize(batchSize)) {
    set.status = 400;
    return { error: 'batchSize must be a positive integer' };
  }
  const key = model ?? 'nomic';
  const preset = models[key];
  if (!preset) {
    set.status = 400;
    return { error: `Default embedding model is not configured: ${key}` };
  }
  const embedding = resolveEmbeddingRuntime(preset);
  const batch = batchSize || (key === 'nomic' ? 100 : 50);

  const { db, sqlite } = createDatabase(DB_PATH);
  const config: IndexerConfig = {
    repoRoot: sourcePath || REPO_ROOT,
    dbPath: DB_PATH,
    chromaPath: '',
    sourcePaths: {
      resonance: `${sourcePath || REPO_ROOT}/memory/resonance`,
      learnings: `${sourcePath || REPO_ROOT}/memory/learnings`,
      retrospectives: `${sourcePath || REPO_ROOT}/memory/retrospectives`,
    },
  };

  const store = createVectorStore({
    type: 'lancedb',
    collectionName: preset.collection,
    embeddingProvider: embedding.provider,
    embeddingModel: embedding.model,
    ...(preset.dataPath && { dataPath: preset.dataPath }),
  });

  abortFlag = false;
  indexerRunning = true;

  const jobId = `idx-${Date.now()}`;

  // Run indexing in background
  (async () => {
    try {
      await store.connect();
      await store.deleteCollection();
      await store.ensureCollection();

      const rows = sqlite.prepare(`
        SELECT d.id, d.type, GROUP_CONCAT(f.content, '\n') as content, d.source_file, d.concepts, d.project, d.created_at
        FROM oracle_documents d
        JOIN oracle_fts f ON d.id = f.id
        GROUP BY d.id
        ORDER BY d.created_at DESC
      `).all() as Array<{
        id: string; type: string; content: string;
        source_file: string; concepts: string; project: string | null; created_at: string;
      }>;

      const total = rows.length;
      setIndexingStatus(sqlite, config, true, 0, total);

      for (let i = 0; i < rows.length; i += batch) {
        if (abortFlag) {
          setIndexingStatus(sqlite, config, false, i, total, 'Cancelled by user');
          break;
        }

        const batchRows = rows.slice(i, i + batch);
        const docs = batchRows.map(row => ({
          id: row.id,
          document: row.content,
          metadata: {
            type: row.type,
            source_file: row.source_file,
            concepts: row.concepts,
            ...(row.project && { project: row.project }),
          },
        }));

        await store.addDocuments(docs);
        setIndexingStatus(sqlite, config, true, i + batchRows.length, total);
      }

      if (!abortFlag) {
        setIndexingStatus(sqlite, config, false, rows.length, rows.length);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setIndexingStatus(sqlite, config, false, 0, 0, msg);
    } finally {
      indexerRunning = false;
      try { await store.close(); } catch {}
      sqlite.close();
    }
  })();

  return { jobId, status: 'started', model: key, batchSize: batch };
}, {
  body: t.Object({
    confirmation: t.Optional(t.String()),
    model: t.Optional(t.String()),
    sourcePath: t.Optional(t.String()),
    batchSize: t.Optional(t.Number()),
  }),
  detail: {
    tags: ['indexer'],
    summary: 'Start vector indexing job',
  },
});
