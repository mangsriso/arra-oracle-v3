/**
 * OpenAIEmbeddings response validation + LiteLLM multi-input cache bypass.
 * No network: fetch is mocked and every instance gets an explicit key / base URL / model.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { OpenAIEmbeddings } from '../embeddings.ts';
import { EmbeddingResponseShapeError, assertEmbeddingResponseShape } from '../provider-error.ts';

const BASE = 'http://mock.local/v1';
const originalFetch = globalThis.fetch;
const ENV = 'ORACLE_OPENAI_CACHE_BYPASS';
let savedEnv: string | undefined;
let calls: Array<{ url: string; headers: Record<string, string>; body: any }>;

const vec = (i: number) => [i + 1, 0.5, -0.25];
const entries = (indices: number[]) => indices.map(index => ({ index, embedding: vec(index) }));
const respondWith = (data: unknown) => {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return Response.json({ data });
  }) as typeof fetch;
};
const provider = (cacheBypass?: boolean) =>
  new OpenAIEmbeddings({ apiKey: 'test-key', baseUrl: BASE, model: 'bge-m3', ...(cacheBypass === undefined ? {} : { cacheBypass }) });
const texts = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

// Index lists of two real cache-served responses (LiteLLM 1.98.0, 50 inputs each).
const LITELLM_BATCH_18750 = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48];
const LITELLM_BATCH_29150 = [0,1,2,3,4,5,6,7,8,9,10,11,12,12,13,14,15,16,17,18,19,20,21,22,23,25,24,25,26,27,28,29,30,31,32,33,34,35,38,36,37,38,39,40,41,42,43,44,45,46];

beforeEach(() => {
  calls = [];
  savedEnv = process.env[ENV];
  delete process.env[ENV];
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe('OpenAIEmbeddings response validation', () => {
  it('returns vectors in input order and posts to the configured base URL', async () => {
    respondWith(entries([0, 1, 2]));
    expect(await provider(false).embed(texts(3))).toEqual([vec(0), vec(1), vec(2)]);
    expect(calls[0].url).toBe(`${BASE}/embeddings`);
  });

  it('reorders a shuffled but complete response by index', async () => {
    respondWith(entries([2, 0, 1]));
    expect(await provider(false).embed(texts(3))).toEqual([vec(0), vec(1), vec(2)]);
  });

  it('fixtures reproduce the observed shape: 50 entries, repeated and missing indices', () => {
    for (const list of [LITELLM_BATCH_18750, LITELLM_BATCH_29150]) {
      expect(list).toHaveLength(50);
      expect(new Set(list).size).toBeLessThan(50);
    }
  });

  it('rejects the observed LiteLLM cache-served responses', async () => {
    for (const list of [LITELLM_BATCH_18750, LITELLM_BATCH_29150]) {
      respondWith(entries(list));
      await expect(provider(false).embed(texts(50))).rejects.toThrow(EmbeddingResponseShapeError);
    }
  });

  it('rejects an extra entry and a missing entry', async () => {
    respondWith(entries([0, 1, 2, 2]));
    await expect(provider(false).embed(texts(3))).rejects.toThrow('4 entries for 3 inputs');
    respondWith(entries([0, 1]));
    await expect(provider(false).embed(texts(3))).rejects.toThrow('2 entries for 3 inputs');
  });

  it('rejects out-of-range and non-integer indices', async () => {
    respondWith(entries([0, 1, 3]));
    await expect(provider(false).embed(texts(3))).rejects.toThrow('outside 0..2');
    respondWith([{ index: 0, embedding: vec(0) }, { index: 0.5, embedding: vec(1) }]);
    await expect(provider(false).embed(texts(2))).rejects.toThrow('outside 0..1');
  });

  it('rejects null entries, missing or empty embeddings and ragged dimensions', async () => {
    const cases: unknown[] = [
      [{ index: 0, embedding: vec(0) }, null],
      [{ index: 0, embedding: vec(0) }, { index: 1 }],
      [{ index: 0, embedding: vec(0) }, { index: 1, embedding: [] }],
      [{ index: 0, embedding: vec(0) }, { index: 1, embedding: [1, 2] }],
      { not: 'an array' },
    ];
    for (const data of cases) {
      respondWith(data);
      await expect(provider(false).embed(texts(2))).rejects.toThrow(EmbeddingResponseShapeError);
    }
  });

  it('validator rejects non-finite values and sparse holes', () => {
    expect(() => assertEmbeddingResponseShape([{ index: 0, embedding: [NaN] }], 1)).toThrow('non-finite');
    expect(() => assertEmbeddingResponseShape([{ index: 0, embedding: [Infinity] }], 1)).toThrow('non-finite');
    const sparse = new Array(2); sparse[1] = { index: 1, embedding: [1] };
    expect(() => assertEmbeddingResponseShape(sparse, 2)).toThrow('entry 0 is not an object');
    expect(() => assertEmbeddingResponseShape([{ index: 0, embedding: [1, , 3] }], 1)).toThrow('non-finite');
  });

  it('validator accepts an empty request', () => {
    expect(assertEmbeddingResponseShape([], 0)).toEqual([]);
  });
});

describe('OpenAIEmbeddings cache bypass (multi-input only)', () => {
  const knobs = (i = 0) => ({ header: calls[i].headers['Cache-Control'], cache: calls[i].body.cache });
  const ON = { header: 'no-cache', cache: { 'no-cache': true, 'no-store': true } };
  const OFF = { header: undefined, cache: undefined };

  it('bypass on + 2 inputs sends both controls', async () => {
    respondWith(entries([0, 1]));
    await provider(true).embed(texts(2));
    expect(knobs()).toEqual(ON);
  });

  it('bypass on + 1 input leaves the request unchanged', async () => {
    respondWith(entries([0]));
    await provider(true).embed(texts(1));
    expect(knobs()).toEqual(OFF);
  });

  it('bypass off + 2 inputs leaves the request unchanged', async () => {
    respondWith(entries([0, 1]));
    await provider(false).embed(texts(2));
    expect(knobs()).toEqual(OFF);
  });

  it('defaults from the environment only when the value is exactly "1"', async () => {
    for (const [value, expected] of [['1', ON], [undefined, OFF], ['0', OFF], ['true', OFF]] as const) {
      calls = [];
      if (value === undefined) delete process.env[ENV]; else process.env[ENV] = value;
      respondWith(entries([0, 1]));
      await provider().embed(texts(2));
      expect(knobs()).toEqual(expected);
    }
  });

  it('an explicit false overrides the environment', async () => {
    process.env[ENV] = '1';
    respondWith(entries([0, 1]));
    await provider(false).embed(texts(2));
    expect(knobs()).toEqual(OFF);
  });

  it('reads the environment once, at construction', async () => {
    process.env[ENV] = '1';
    const early = provider();
    delete process.env[ENV];
    const late = provider();
    respondWith(entries([0, 1]));
    await early.embed(texts(2));
    await late.embed(texts(2));
    expect(knobs(0)).toEqual(ON);
    expect(knobs(1)).toEqual(OFF);
  });
});
