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
    let refreshed = 0;
    const query = {
      select(columns: string[]) {
        selected = columns;
        return this;
      },
      async toArray() {
        return [{ id: 'one', text: 'text one' }, { id: 2, text: null }];
      },
    };
    (adapter as unknown as { table: unknown }).table = {
      async checkoutLatest() {
        refreshed++;
      },
      query: () => query,
    };

    await expect(adapter.getDocumentTexts()).resolves.toEqual([
      { id: 'one', text: 'text one' },
      { id: '2', text: '' },
    ]);
    expect(selected).toEqual(['id', 'text']);
    expect(refreshed).toBe(1);
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

  it('refreshes an existing handle before reporting count and version', async () => {
    const adapter = new LanceDBAdapter('test', '/unused', new MockEmbedder());
    let count = 24_416;
    (adapter as unknown as { table: unknown }).table = {
      async checkoutLatest() {
        count = 24_662;
      },
      async countRows() {
        return count;
      },
      async version() {
        return 77;
      },
    };

    const stats = await adapter.getStats();

    expect(stats.count).toBe(24_662);
    expect(stats.version).toBe(77);
    expect(typeof stats.refreshedAt).toBe('string');
  });

  it('opens and refreshes an existing table on the first embedding read', async () => {
    const adapter = new LanceDBAdapter('test', '/unused', new MockEmbedder());
    let refreshed = 0;
    const table = {
      async checkoutLatest() {
        refreshed++;
      },
      query() {
        return {
          limit() {
            return this;
          },
          async toArray() {
            return [{ id: 'new', vector: [0.1, 0.9], metadata: '{"type":"learning"}' }];
          },
        };
      },
    };
    (adapter as unknown as { db: unknown }).db = {
      async tableNames() {
        return ['test'];
      },
      async openTable() {
        return table;
      },
    };

    const result = await adapter.getAllEmbeddings();

    expect(refreshed).toBe(1);
    expect(result).toEqual({
      ids: ['new'],
      embeddings: [[0.1, 0.9]],
      metadatas: [{ type: 'learning' }],
    });
  });

  it('surfaces refresh failures instead of reporting a false zero count', async () => {
    const adapter = new LanceDBAdapter('test', '/unused', new MockEmbedder());
    (adapter as unknown as { table: unknown }).table = {
      async checkoutLatest() {
        throw new Error('version unavailable');
      },
    };

    await expect(adapter.getStats()).rejects.toThrow('version unavailable');
  });

  it('refreshes the table after embedding and before semantic search', async () => {
    const events: string[] = [];
    const embedder = new MockEmbedder();
    embedder.embed = async () => {
      events.push('embed');
      return [[0.25, 0.75]];
    };
    const adapter = new LanceDBAdapter('test', '/unused', embedder);
    const builder = {
      distanceType() {
        return this;
      },
      limit() {
        return this;
      },
      async toArray() {
        return [{ id: 'new-doc', text: 'visible', metadata: '{}', _distance: 0.1 }];
      },
    };
    (adapter as unknown as { table: unknown }).table = {
      async checkoutLatest() {
        events.push('refresh');
      },
      search() {
        events.push('search');
        return builder;
      },
    };

    const result = await adapter.query('new knowledge', 1);

    expect(events).toEqual(['embed', 'refresh', 'search']);
    expect(result.ids).toEqual(['new-doc']);
  });
});
