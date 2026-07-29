/**
 * Resolve the embedding identity used by every vector/indexer runtime.
 *
 * Deployment environment overrides are global and take precedence over the
 * per-collection vector-server.json registry. The function is pure when an
 * explicit env object is supplied, which keeps configuration tests hermetic.
 */

import type { EmbeddingModelPreset } from './config.ts';
import type { EmbeddingProviderType } from './types.ts';

export interface EmbeddingRuntime {
  provider: EmbeddingProviderType;
  model: string;
}

const EMBEDDING_PROVIDERS = new Set<EmbeddingProviderType>([
  'chromadb-internal',
  'ollama',
  'openai',
  'cloudflare-ai',
]);

function embeddingProvider(value: string | undefined): EmbeddingProviderType {
  if (value && EMBEDDING_PROVIDERS.has(value as EmbeddingProviderType)) {
    return value as EmbeddingProviderType;
  }
  throw new Error(`Unsupported embedding provider: ${value || '(empty)'}`);
}

export function resolveEmbeddingRuntime(
  preset: EmbeddingModelPreset,
  env: Record<string, string | undefined> = process.env,
): EmbeddingRuntime {
  const provider = env.ORACLE_EMBEDDING_PROVIDER || preset.provider;
  const model = env.ORACLE_EMBEDDING_MODEL || preset.model;
  if (!model.trim()) throw new Error('Embedding model must not be empty');
  return {
    provider: embeddingProvider(provider),
    model,
  };
}
