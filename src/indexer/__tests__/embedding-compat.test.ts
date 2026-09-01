import { afterEach, describe, expect, it } from 'bun:test';
import { OllamaEmbeddings } from '../../vector/embeddings.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('embedding dimension compatibility', () => {
  it('keeps custom Ollama legacy callers compatible while exposing an unknown guess', () => {
    const provider = new OllamaEmbeddings({ model: 'custom-non-768-model' });
    expect(provider.dimensions).toBe(768);
    expect(provider.dimensionKnown).toBe(false);
  });

  it('normalizes Ollama bge-m3 vectors for the Lance dot-distance contract', async () => {
    globalThis.fetch = (async () => Response.json({ embedding: [3, 4] })) as typeof fetch;
    const provider = new OllamaEmbeddings({ model: 'bge-m3:latest' });
    expect(await provider.embed(['text'])).toEqual([[0.6, 0.8]]);
  });

  it('rejects a zero-norm Ollama bge-m3 vector', async () => {
    globalThis.fetch = (async () => Response.json({ embedding: [0, 0] })) as typeof fetch;
    const provider = new OllamaEmbeddings({ model: 'bge-m3' });
    await expect(provider.embed(['text'])).rejects.toThrow('invalid L2 norm');
  });
});
