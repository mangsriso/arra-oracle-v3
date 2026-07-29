import { describe, expect, it } from 'bun:test';
import { LanceDBAdapter } from '../adapters/lancedb.ts';
import type { EmbeddingProvider, EmbedType } from '../types.ts';

class MockEmbedder implements EmbeddingProvider {
  readonly name = 'mock';
  readonly dimensions = 2;
  calls: Array<{ texts: string[]; type?: EmbedType }> = [];

  async embed(texts: string[], type?: EmbedType): Promise<number[][]> {
    this.calls.push({ texts, type });
    return texts.map(() => [0.25, 0.75]);
  }
}

describe('LanceDB incremental adapter methods', () => {
  it('reads only id and text columns', async () => {
    const adapter = new LanceDBAdapter('test', '/unused', new MockEmbedder());
    let selected: string[] = [];
    const query = {
      select(columns: string[]) {
        selected = columns;
        return this;
      },
      async toArray() {
        return [{ id: 'one', text: 'text one' }, { id: 2, text: null }];
      },
    };
    (adapter as unknown as { table: unknown }).table = { query: () => query };

    await expect(adapter.getDocumentTexts()).resolves.toEqual([
      { id: 'one', text: 'text one' },
      { id: '2', text: '' },
    ]);
    expect(selected).toEqual(['id', 'text']);
  });

  it('uses mergeInsert(id) for both inserts and changed rows', async () => {
    const embedder = new MockEmbedder();
    const adapter = new LanceDBAdapter('test', '/unused', embedder);
    let mergeKey = '';
    let matched = false;
    let inserted = false;
    let executedRows: unknown[] = [];
    const builder: Record<string, unknown> = {};
    builder.whenMatchedUpdateAll = () => {
      matched = true;
      return builder;
    };
    builder.whenNotMatchedInsertAll = () => {
      inserted = true;
      return builder;
    };
    builder.execute = async (rows: unknown[]) => {
      executedRows = rows;
    };
    const table = {
      mergeInsert(key: string) {
        mergeKey = key;
        return builder;
      },
      async add() {
        throw new Error('append path must not be used');
      },
    };
    (adapter as unknown as { table: unknown }).table = table;

    await adapter.upsertDocuments([
      { id: 'stale', document: 'new text', metadata: { type: 'test' } },
    ]);

    expect(mergeKey).toBe('id');
    expect(matched).toBe(true);
    expect(inserted).toBe(true);
    expect(embedder.calls).toEqual([{ texts: ['new text'], type: 'passage' }]);
    expect(executedRows).toEqual([{
      id: 'stale',
      text: 'new text',
      metadata: '{"type":"test"}',
      vector: [0.25, 0.75],
    }]);
  });
});
