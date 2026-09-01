import { describe, expect, it } from 'bun:test';
import { resolveAsyncIndexerConfig } from '../../vector/indexer-config.ts';
import { TEST_ENV, TEST_MODELS } from '../../learn/__tests__/fixture.ts';

describe('arra_learn async mode preflight', () => {
  it('keeps producer and workers default-off', () => {
    expect(resolveAsyncIndexerConfig(TEST_MODELS, {})).toMatchObject({
      producerEnabled: false, workersEnabled: false, readiness: 'disabled', modelKey: null,
    });
  });

  it('resolves one explicit active key/revision without fan-out', () => {
    const config = resolveAsyncIndexerConfig(TEST_MODELS, TEST_ENV);
    expect(config).toMatchObject({
      producerEnabled: true, workersEnabled: false, modelKey: 'test',
      collection: 'learn_test_vectors', dimension: 3, metadataSchemaVersion: 1,
      readiness: 'ready',
    });
    expect(config.indexRevision).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects missing/unknown key, revision, and malformed flags', () => {
    expect(() => resolveAsyncIndexerConfig(TEST_MODELS, { ORACLE_INDEXER_ENQUEUE: '1' }))
      .toThrow('ORACLE_EMBEDDING_MODEL_KEY');
    expect(() => resolveAsyncIndexerConfig(TEST_MODELS, {
      ...TEST_ENV, ORACLE_EMBEDDING_MODEL_KEY: 'missing',
    })).toThrow('Unknown');
    expect(() => resolveAsyncIndexerConfig(TEST_MODELS, {
      ...TEST_ENV, ORACLE_EMBEDDING_DEPLOYMENT_REVISION: undefined,
    })).toThrow('ARTIFACT_IDENTITY');
    expect(() => resolveAsyncIndexerConfig(TEST_MODELS, {
      ORACLE_INDEXER_ENQUEUE: 'true',
    })).toThrow('must be 0 or 1');
    expect(() => resolveAsyncIndexerConfig(TEST_MODELS, {
      ORACLE_INDEXER_ENQUEUE: '',
    })).toThrow('must be 0 or 1');
  });

  for (const [field, value, message] of [
    ['dimension', 0, 'dimension'],
    ['metadataSchemaVersion', 0, 'Metadata schema'],
    ['supportsAbort', false, 'Abortable'],
    ['supportsPrecomputedUpsert', false, 'precomputed upsert'],
  ] as const) {
    it(`fails producer preflight when ${field} is invalid`, () => {
      const models = { test: { ...TEST_MODELS.test, [field]: value } };
      expect(() => resolveAsyncIndexerConfig(models, TEST_ENV)).toThrow(message);
    });
  }
});
