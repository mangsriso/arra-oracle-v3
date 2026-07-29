/**
 * C-02 regression: destructive reindex routes reject before touching state or
 * dependencies unless the exact confirmation token is supplied.
 */

import { afterAll, describe, expect, it, mock } from 'bun:test';
import { Elysia } from 'elysia';
import fs from 'fs';
import os from 'os';
import path from 'path';

const originalDataDir = process.env.ORACLE_DATA_DIR;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reindex-confirmation-'));
process.env.ORACLE_DATA_DIR = tmp;

const getEmbeddingModels = mock(() => ({
  'bge-m3': {
    collection: 'bge_m3',
    model: 'bge-m3',
    provider: 'ollama' as const,
  },
  nomic: {
    collection: 'nomic',
    model: 'nomic-embed-text',
    provider: 'ollama' as const,
  },
}));
const createVectorStore = mock(() => {
  throw new Error('vector store must not be created');
});
const createDatabase = mock(() => {
  throw new Error('database must not be opened');
});
const setIndexingStatus = mock(() => {
  throw new Error('job state must not be written');
});

mock.module(path.resolve(import.meta.dir, '../../../vector/factory.ts'), () => ({
  getEmbeddingModels,
  createVectorStore,
}));
mock.module(path.resolve(import.meta.dir, '../../../db/index.ts'), () => ({
  createDatabase,
}));
mock.module(path.resolve(import.meta.dir, '../../../indexer/status.ts'), () => ({
  setIndexingStatus,
}));

const {
  vectorIndexerEndpoints,
} = await import('../indexer.ts');
const {
  getAbortFlag,
  setAbortFlag,
  startEndpoint,
} = await import('../../indexer/start.ts');
const { REINDEX_CONFIRMATION } = await import('../../../vector/reindex-guard.ts');

const vectorApp = new Elysia().use(vectorIndexerEndpoints);
const indexerApp = new Elysia().use(startEndpoint);

function post(app: Elysia, url: string, body: Record<string, unknown>) {
  return app.handle(new Request(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.ORACLE_DATA_DIR;
  else process.env.ORACLE_DATA_DIR = originalDataDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('destructive vector reindex confirmation', () => {
  it('rejects missing and wrong tokens before either route has side effects', async () => {
    for (const confirmation of [undefined, 'REINDEX']) {
      const body = confirmation === undefined ? {} : { confirmation };
      const vectorResponse = await post(vectorApp, '/vector/index/start', body);
      expect(vectorResponse.status).toBe(400);
      expect(await vectorResponse.json()).toMatchObject({
        requiredConfirmation: REINDEX_CONFIRMATION,
      });

      setAbortFlag(true);
      const indexerResponse = await post(indexerApp, '/indexer/start', body);
      expect(indexerResponse.status).toBe(400);
      expect(await indexerResponse.json()).toMatchObject({
        requiredConfirmation: REINDEX_CONFIRMATION,
      });
      expect(getAbortFlag()).toBe(true);
    }

    const statusResponse = await vectorApp.handle(
      new Request('http://localhost/vector/index/status'),
    );
    expect(await statusResponse.json()).toMatchObject({ status: 'idle' });
    expect(getEmbeddingModels).not.toHaveBeenCalled();
    expect(createVectorStore).not.toHaveBeenCalled();
    expect(createDatabase).not.toHaveBeenCalled();
    expect(setIndexingStatus).not.toHaveBeenCalled();
  });

  it('rejects unknown models and invalid batches before opening storage', async () => {
    for (const [app, prefix] of [
      [vectorApp, '/vector/index/start'],
      [indexerApp, '/indexer/start'],
    ] as const) {
      const unknown = await post(app, prefix, {
        confirmation: REINDEX_CONFIRMATION,
        model: 'not-deployed',
      });
      expect(unknown.status).toBe(400);
      expect(await unknown.json()).toMatchObject({
        error: 'Unknown embedding model: not-deployed',
      });

      for (const batchSize of [0, -1, 1.5]) {
        const invalidBatch = await post(app, prefix, {
          confirmation: REINDEX_CONFIRMATION,
          batchSize,
        });
        expect(invalidBatch.status).toBe(400);
        expect(await invalidBatch.json()).toMatchObject({
          error: 'batchSize must be a positive integer',
        });
      }
    }

    expect(createVectorStore).not.toHaveBeenCalled();
    expect(createDatabase).not.toHaveBeenCalled();
    expect(setIndexingStatus).not.toHaveBeenCalled();
  });
});
