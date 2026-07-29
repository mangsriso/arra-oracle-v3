#!/usr/bin/env bun
/**
 * Generic embedding model indexer.
 * Reads model config from EMBEDDING_MODELS registry in factory.ts.
 *
 * Usage:
 *   bun src/scripts/index-model.ts bge-m3
 *   bun src/scripts/index-model.ts qwen3
 *   bun src/scripts/index-model.ts nomic
 *   bun src/scripts/index-model.ts bge-m3 --rebuild
 */

import { Database } from 'bun:sqlite';
import { createVectorStore, getEmbeddingModels } from '../vector/factory.ts';
import { loadVectorConfig } from '../vector/config.ts';
import { resolveEmbeddingRuntime } from '../vector/runtime-config.ts';
import { DB_PATH } from '../config.ts';
import {
  hasConfiguredEmbeddingProvider,
  runIncrementalBackfill,
  supportsIncrementalBackfill,
} from './index-model-backfill.ts';

function parseArguments(models: Record<string, unknown>): { modelKey: string; rebuild: boolean } {
  const args = process.argv.slice(2);
  const unknownFlags = args.filter(arg => arg.startsWith('--') && arg !== '--rebuild');
  const modelKeys = args.filter(arg => !arg.startsWith('--'));
  const modelKey = modelKeys[0];
  if (unknownFlags.length > 0 || modelKeys.length !== 1 || !models[modelKey]) {
    console.error('Usage: bun src/scripts/index-model.ts <model> [--rebuild]');
    console.error(`Available models: ${Object.keys(models).join(', ')}`);
    if (unknownFlags.length > 0) console.error(`Unknown option: ${unknownFlags.join(', ')}`);
    throw new Error('Invalid indexer arguments');
  }
  return { modelKey, rebuild: args.includes('--rebuild') };
}

async function main() {
  const models = getEmbeddingModels();
  const { modelKey, rebuild } = parseArguments(models);
  const preset = models[modelKey];
  const embedding = resolveEmbeddingRuntime(preset);
  const vectorConfig = loadVectorConfig();
  const batchSize = modelKey === 'nomic' ? 100 : 50;

  console.log(`=== ${modelKey} Indexer ===`);
  console.log(`DB: ${DB_PATH}`);
  console.log(`Collection: ${preset.collection}`);
  console.log(`Provider: ${embedding.provider}`);
  console.log(`Model: ${embedding.model}`);
  console.log(`Batch size: ${batchSize}`);

  const sqlite = new Database(DB_PATH, { readonly: true });
  try {
    const sqliteIds = (sqlite.prepare(
      'SELECT id FROM oracle_documents ORDER BY id',
    ).all() as Array<{ id: string }>).map(row => row.id);
    console.log(`Documents: ${sqliteIds.length}`);

    // FTS5 join requires raw SQL — Drizzle doesn't support virtual tables.
    const rows = sqlite.prepare(`
      SELECT d.id, d.type, GROUP_CONCAT(f.content, '\n') as content,
             d.source_file, d.concepts, d.project
      FROM oracle_documents d
      JOIN oracle_fts f ON d.id = f.id
      GROUP BY d.id
      ORDER BY d.created_at DESC
    `).all() as Array<{
      id: string;
      type: string;
      content: string;
      source_file: string;
      concepts: string;
      project: string | null;
    }>;

    const sourceDocuments = rows.map(row => ({
      id: row.id,
      document: row.content,
      metadata: {
        type: row.type,
        source_file: row.source_file,
        concepts: row.concepts,
        ...(row.project && { project: row.project }),
      },
    }));

    const store = createVectorStore({
      type: 'lancedb',
      collectionName: preset.collection,
      embeddingProvider: embedding.provider,
      embeddingModel: embedding.model,
      ...(preset.dataPath && { dataPath: preset.dataPath }),
    });
    if (!supportsIncrementalBackfill(store)) {
      throw new Error('Selected vector adapter does not support incremental backfill');
    }

    await runIncrementalBackfill({
      store,
      sourceDocuments,
      sqliteIds,
      modelKey,
      batchSize,
      providerConfigured: hasConfiguredEmbeddingProvider(
        modelKey,
        process.env,
        vectorConfig,
      ),
      rebuild,
    });
  } finally {
    sqlite.close();
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error('Indexer failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
