import { describe, expect, spyOn, test } from 'bun:test';
import { LanceDBAdapter } from '../adapters/lancedb.ts';
import { isStringArray, parseRecordJson } from '../safe-json.ts';
import type { EmbeddingProvider } from '../types.ts';

const embedder: EmbeddingProvider = {
  name: 'fixture',
  dimensions: 2,
  embed: async () => [],
};

describe('record-scoped JSON parsing', () => {
  test('Lance metadata fallback preserves row alignment and reports record id', async () => {
    const warning = spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = new LanceDBAdapter('fixture', '/unused', embedder);
    (adapter as any).table = {
      query: () => ({
        limit: () => ({
          toArray: async () => [
            { id: 'good', vector: [1, 2], metadata: '{"type":"learning"}' },
            { id: 'bad', vector: [3, 4], metadata: '^not-json' },
          ],
        }),
      }),
    };

    const result = await adapter.getAllEmbeddings();

    expect(result.ids).toEqual(['good', 'bad']);
    expect(result.embeddings).toEqual([[1, 2], [3, 4]]);
    expect(result.metadatas).toEqual([{ type: 'learning' }, {}]);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('lancedb.metadata'));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('"bad"'));
    warning.mockRestore();
  });

  test('SQLite concepts fallback is isolated to the malformed record', () => {
    const messages: string[] = [];
    const valid = parseRecordJson(
      '["oracle","memory"]',
      [],
      'sqlite.concepts',
      'doc-good',
      isStringArray,
      (message) => messages.push(message),
    );
    const invalid = parseRecordJson(
      '^not-json',
      [],
      'sqlite.concepts',
      'doc-bad',
      isStringArray,
      (message) => messages.push(message),
    );

    expect(valid).toEqual(['oracle', 'memory']);
    expect(invalid).toEqual([]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('sqlite.concepts');
    expect(messages[0]).toContain('"doc-bad"');
  });
});
