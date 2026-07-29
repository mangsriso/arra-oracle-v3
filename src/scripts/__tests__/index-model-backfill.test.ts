import { describe, expect, it } from 'bun:test';
import {
  classifyDocuments,
  hasConfiguredEmbeddingProvider,
  runIncrementalBackfill,
  verifyUniqueIds,
  type IncrementalVectorStore,
} from '../index-model-backfill.ts';
import type { StoredDocumentText, VectorDocument, VectorQueryResult } from '../../vector/types.ts';

const emptyQuery: VectorQueryResult = {
  ids: [],
  documents: [],
  distances: [],
  metadatas: [],
};

function doc(id: string, text: string): VectorDocument {
  return { id, document: text, metadata: { type: 'test' } };
}

class FakeIncrementalStore implements IncrementalVectorStore {
  readonly name = 'fake';
  rows: StoredDocumentText[];
  deleteCalls = 0;
  upsertCalls: string[][] = [];
  failOnId: string | null = null;

  constructor(rows: StoredDocumentText[]) {
    this.rows = rows.map(row => ({ ...row }));
  }

  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async ensureCollection(): Promise<void> {}
  async deleteCollection(): Promise<void> {
    this.deleteCalls++;
    this.rows = [];
  }
  async addDocuments(): Promise<void> {
    throw new Error('append path must not be used');
  }
  async upsertDocuments(docs: VectorDocument[]): Promise<void> {
    this.upsertCalls.push(docs.map(item => item.id));
    if (this.failOnId && docs.some(item => item.id === this.failOnId)) {
      throw new Error(`simulated failure for ${this.failOnId}`);
    }
    for (const item of docs) {
      const index = this.rows.findIndex(row => row.id === item.id);
      const next = { id: item.id, text: item.document };
      if (index === -1) this.rows.push(next);
      else this.rows[index] = next;
    }
  }
  async getDocumentTexts(): Promise<StoredDocumentText[]> {
    return this.rows.map(row => ({ ...row }));
  }
  async query(): Promise<VectorQueryResult> { return emptyQuery; }
  async queryById(): Promise<VectorQueryResult> { return emptyQuery; }
  async getStats(): Promise<{ count: number }> { return { count: this.rows.length }; }
  async getCollectionInfo(): Promise<{ count: number; name: string }> {
    return { count: this.rows.length, name: 'fake' };
  }
}

describe('incremental model backfill', () => {
  it('classifies unchanged, missing, and stale IDs', () => {
    const plan = classifyDocuments(
      [doc('same', 'same text'), doc('missing', 'new text'), doc('stale', 'new text')],
      [{ id: 'same', text: 'same text' }, { id: 'stale', text: 'old text' }],
    );

    expect(plan.skipped).toBe(1);
    expect(plan.inserts.map(item => item.id)).toEqual(['missing']);
    expect(plan.upserts.map(item => item.id)).toEqual(['stale']);
  });

  it('upserts only changed rows and verifies unique SQLite IDs', async () => {
    const store = new FakeIncrementalStore([
      { id: 'same', text: 'same text' },
      { id: 'stale', text: 'old text' },
    ]);
    const source = [
      doc('same', 'same text'),
      doc('missing', 'new text'),
      doc('stale', 'new text'),
    ];

    const result = await runIncrementalBackfill({
      store,
      sourceDocuments: source,
      sqliteIds: source.map(item => item.id),
      modelKey: 'bge-m3',
      batchSize: 50,
      providerConfigured: true,
      log: () => {},
    });

    expect(result.skipped).toBe(1);
    expect(store.upsertCalls).toEqual([['missing', 'stale']]);
    expect(store.deleteCalls).toBe(0);
    expect(store.rows).toEqual([
      { id: 'same', text: 'same text' },
      { id: 'stale', text: 'new text' },
      { id: 'missing', text: 'new text' },
    ]);
  });

  it('stops on a failed batch and a rerun picks up only outstanding rows', async () => {
    const store = new FakeIncrementalStore([{ id: 'same', text: 'same text' }]);
    const source = [doc('same', 'same text'), doc('first', 'one'), doc('failed', 'two')];
    store.failOnId = 'failed';

    await expect(runIncrementalBackfill({
      store,
      sourceDocuments: source,
      sqliteIds: source.map(item => item.id),
      modelKey: 'bge-m3',
      batchSize: 1,
      providerConfigured: true,
      log: () => {},
      reportError: () => {},
    })).rejects.toThrow('rerun will pick up only outstanding rows');

    expect(store.deleteCalls).toBe(0);
    expect(store.rows.map(row => row.id).sort()).toEqual(['first', 'same']);

    store.failOnId = null;
    store.upsertCalls = [];
    const rerun = await runIncrementalBackfill({
      store,
      sourceDocuments: source,
      sqliteIds: source.map(item => item.id),
      modelKey: 'bge-m3',
      batchSize: 1,
      providerConfigured: true,
      log: () => {},
    });
    expect(rerun.skipped).toBe(2);
    expect(rerun.inserts.map(item => item.id)).toEqual(['failed']);
    expect(store.upsertCalls).toEqual([['failed']]);
  });

  it('fails before writes when populated data has no configured provider', async () => {
    const store = new FakeIncrementalStore([{ id: 'existing', text: 'text' }]);
    await expect(runIncrementalBackfill({
      store,
      sourceDocuments: [doc('existing', 'text')],
      sqliteIds: ['existing'],
      modelKey: 'bge-m3',
      batchSize: 50,
      providerConfigured: false,
      log: () => {},
    })).rejects.toThrow('no embedding provider is configured');
    expect(store.deleteCalls).toBe(0);
    expect(store.upsertCalls).toHaveLength(0);
  });

  it('deletes only when full rebuild is explicitly requested', async () => {
    const store = new FakeIncrementalStore([{ id: 'existing', text: 'old' }]);
    await runIncrementalBackfill({
      store,
      sourceDocuments: [doc('existing', 'new')],
      sqliteIds: ['existing'],
      modelKey: 'bge-m3',
      batchSize: 50,
      providerConfigured: true,
      rebuild: true,
      log: () => {},
    });
    expect(store.deleteCalls).toBe(1);
    expect(store.upsertCalls).toEqual([['existing']]);
  });

  it('compares ID sets and reports duplicates instead of trusting row counts', () => {
    expect(verifyUniqueIds(
      ['a', 'b'],
      [{ id: 'a' }, { id: 'a' }, { id: 'c' }],
    )).toEqual({
      expected: 2,
      actual: 2,
      missing: ['b'],
      unexpected: ['c'],
      duplicates: ['a'],
    });
  });

  it('recognizes only env or vector-server.json as explicit provider sources', () => {
    expect(hasConfiguredEmbeddingProvider('bge-m3', {}, null)).toBe(false);
    expect(hasConfiguredEmbeddingProvider(
      'bge-m3',
      { ORACLE_EMBEDDING_PROVIDER: 'openai' },
      null,
    )).toBe(true);
    expect(hasConfiguredEmbeddingProvider(
      'bge-m3',
      {},
      { collections: { 'bge-m3': { provider: 'openai' } } },
    )).toBe(true);
  });
});
