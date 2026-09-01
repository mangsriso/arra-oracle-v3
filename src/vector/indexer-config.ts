import type { EmbeddingModelPreset } from './config.ts';
import { resolveEmbeddingRuntime } from './runtime-config.ts';

export interface AsyncIndexerConfig {
  producerEnabled: boolean;
  workersEnabled: boolean;
  modelKey: string | null;
  collection: string | null;
  dimension: number | null;
  metadataSchemaVersion: number | null;
  indexRevision: string | null;
  artifactIdentity: string | null;
  supportsAbort: boolean;
  supportsPrecomputedUpsert: boolean;
  readiness: 'disabled' | 'ready';
}

function enabled(name: string, value: string | undefined): boolean {
  if (value === undefined || value === '0') return false;
  if (value === '1') return true;
  throw new Error(`${name} must be 0 or 1`);
}

function endpointIdentity(raw: string | undefined): string {
  if (!raw) return 'default';
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    throw new Error('Embedding endpoint must be a valid URL');
  }
}

function sha256(value: string): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

export function resolveAsyncIndexerConfig(
  models: Record<string, EmbeddingModelPreset>,
  env: Record<string, string | undefined> = process.env,
): AsyncIndexerConfig {
  const producerEnabled = enabled('ORACLE_INDEXER_ENQUEUE', env.ORACLE_INDEXER_ENQUEUE);
  const workersEnabled = enabled(
    'ORACLE_INDEXER_WORKERS_ENABLED',
    env.ORACLE_INDEXER_WORKERS_ENABLED,
  );
  if (!producerEnabled && !workersEnabled) {
    return {
      producerEnabled, workersEnabled, modelKey: null, collection: null,
      dimension: null, metadataSchemaVersion: null, indexRevision: null,
      artifactIdentity: null, supportsAbort: false, supportsPrecomputedUpsert: false,
      readiness: 'disabled',
    };
  }

  const modelKey = env.ORACLE_EMBEDDING_MODEL_KEY?.trim();
  if (!modelKey) throw new Error('ORACLE_EMBEDDING_MODEL_KEY is required when async indexing is enabled');
  const preset = models[modelKey];
  if (!preset) throw new Error(`Unknown ORACLE_EMBEDDING_MODEL_KEY: ${modelKey}`);
  if (!Number.isInteger(preset.dimension) || preset.dimension <= 0) {
    throw new Error(`Embedding dimension is invalid for model key: ${modelKey}`);
  }
  if (!Number.isInteger(preset.metadataSchemaVersion) || preset.metadataSchemaVersion <= 0) {
    throw new Error(`Metadata schema version is invalid for model key: ${modelKey}`);
  }
  if (preset.supportsAbort !== true) {
    throw new Error(`Abortable embedding is required for model key: ${modelKey}`);
  }
  if (preset.supportsPrecomputedUpsert !== true) {
    throw new Error(`Keyed precomputed upsert is required for model key: ${modelKey}`);
  }
  const runtime = resolveEmbeddingRuntime(preset, env);
  if (!runtime.supportsAbort) {
    throw new Error(`Selected embedding provider does not support cancellation: ${runtime.provider}`);
  }
  const suppliedArtifact = env.ORACLE_EMBEDDING_ARTIFACT_IDENTITY?.trim();
  const deploymentRevision = env.ORACLE_EMBEDDING_DEPLOYMENT_REVISION?.trim();
  if (!suppliedArtifact && !deploymentRevision) {
    throw new Error(
      'ORACLE_EMBEDDING_ARTIFACT_IDENTITY or ORACLE_EMBEDDING_DEPLOYMENT_REVISION is required',
    );
  }
  const artifactIdentity = suppliedArtifact || `unavailable:${runtime.provider}`;
  const manifest = JSON.stringify({
    version: 1,
    modelKey,
    provider: runtime.provider,
    model: runtime.model,
    artifactIdentity,
    deploymentRevision: deploymentRevision || null,
    endpointIdentity: sha256(endpointIdentity(
      env.ORACLE_EMBEDDING_ENDPOINT || env.OLLAMA_BASE_URL || env.ORACLE_OPENAI_BASE_URL,
    )),
    preprocessingVersion: 1,
    adapterVersion: 1,
    dimension: preset.dimension,
    collection: preset.collection,
    storageIdentity: sha256(preset.dataPath || 'default'),
    metadataSchemaVersion: preset.metadataSchemaVersion,
    supportsAbort: runtime.supportsAbort,
    supportsPrecomputedUpsert: preset.supportsPrecomputedUpsert,
  });
  return {
    producerEnabled,
    workersEnabled,
    modelKey,
    collection: preset.collection,
    dimension: preset.dimension,
    metadataSchemaVersion: preset.metadataSchemaVersion,
    indexRevision: sha256(manifest),
    artifactIdentity,
    supportsAbort: runtime.supportsAbort,
    supportsPrecomputedUpsert: preset.supportsPrecomputedUpsert,
    readiness: 'ready',
  };
}
