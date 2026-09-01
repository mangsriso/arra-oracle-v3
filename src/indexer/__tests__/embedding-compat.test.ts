import { describe, expect, it } from 'bun:test';
import { OllamaEmbeddings } from '../../vector/embeddings.ts';

describe('embedding dimension compatibility', () => {
  it('keeps custom Ollama legacy callers compatible while exposing an unknown guess', () => {
    const provider = new OllamaEmbeddings({ model: 'custom-non-768-model' });
    expect(provider.dimensions).toBe(768);
    expect(provider.dimensionKnown).toBe(false);
  });
});
