import type Database from 'bun:sqlite';
import { persistAsyncLearning } from '../learn/persistence.ts';
import { resolveLearnStorage } from '../learn/storage.ts';
import { getEmbeddingModels } from '../vector/factory.ts';
import { resolveAsyncIndexerConfig } from '../vector/indexer-config.ts';

export async function persistServerAsyncLearning(sqlite: Database, input: {
  pattern: string; source?: string; concepts?: string[]; origin?: string;
  project: string | null; idempotencyKey?: string;
}) {
  const models = getEmbeddingModels();
  const runtime = resolveAsyncIndexerConfig(models);
  if (!runtime.producerEnabled) {
    if (process.env.ORACLE_LEARN_LEGACY_MODE === '1') return null;
    throw new Error(
      'arra_learn persistence is disabled; enable the async producer or explicitly set ORACLE_LEARN_LEGACY_MODE=1',
    );
  }
  const storage = resolveLearnStorage(input.project);
  return persistAsyncLearning({
    sqlite, learningDir: storage.learningDir,
    sourceFilePrefix: storage.sourceFilePrefix, models,
  }, {
    pattern: input.pattern, source: input.source, concepts: input.concepts,
    origin: input.origin || null, project: input.project,
    idempotencyKey: input.idempotencyKey,
  });
}
