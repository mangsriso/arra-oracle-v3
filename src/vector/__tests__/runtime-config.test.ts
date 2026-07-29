/** M-08 regression tests for deployed embedding provider/model resolution. */

import { afterAll, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveEmbeddingRuntime } from '../runtime-config.ts';

const originalDataDir = process.env.ORACLE_DATA_DIR;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-runtime-config-'));
process.env.ORACLE_DATA_DIR = tmp;

const { configToModels } = await import('../config.ts');

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.ORACLE_DATA_DIR;
  else process.env.ORACLE_DATA_DIR = originalDataDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('embedding runtime configuration', () => {
  const registry = configToModels({
    version: '1.0',
    host: '127.0.0.1',
    port: 8081,
    dataPath: '/tmp/test-vector-data',
    embeddingEndpoint: 'https://embedding.example.invalid',
    collections: {
      primary: {
        collection: 'test_collection',
        model: 'registry-model',
        provider: 'openai',
        primary: true,
      },
    },
  });

  it('preserves provider, model, and data path from the registry', () => {
    expect(registry.primary).toEqual({
      collection: 'test_collection',
      model: 'registry-model',
      provider: 'openai',
      dataPath: '/tmp/test-vector-data',
    });
    expect(resolveEmbeddingRuntime(registry.primary, {})).toEqual({
      provider: 'openai',
      model: 'registry-model',
    });
  });

  it('gives deployment environment provider/model exact precedence', () => {
    expect(resolveEmbeddingRuntime(registry.primary, {
      ORACLE_EMBEDDING_PROVIDER: 'cloudflare-ai',
      ORACLE_EMBEDDING_MODEL: 'environment-model',
    })).toEqual({
      provider: 'cloudflare-ai',
      model: 'environment-model',
    });
  });

  it('rejects unsupported providers and empty deployment models', () => {
    expect(() => resolveEmbeddingRuntime(registry.primary, {
      ORACLE_EMBEDDING_PROVIDER: 'typo-provider',
    })).toThrow('Unsupported embedding provider: typo-provider');

    expect(() => resolveEmbeddingRuntime(registry.primary, {
      ORACLE_EMBEDDING_MODEL: '   ',
    })).toThrow('Embedding model must not be empty');
  });
});
