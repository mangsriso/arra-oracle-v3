/**
 * Embedding Providers
 *
 * Ported from Nat-s-Agents data-aware-rag.
 * ChromaDB handles embeddings internally; other stores need these.
 */

import type { EmbeddingProvider, EmbeddingProviderType } from './types.ts';
import { EmbeddingProviderHttpError } from './provider-error.ts';

/**
 * Placeholder for ChromaDB's internal embeddings.
 * ChromaDB generates embeddings server-side — this is never called directly.
 */
export class ChromaDBInternalEmbeddings implements EmbeddingProvider {
  readonly name = 'chromadb-internal';
  readonly dimensions = 384; // all-MiniLM-L6-v2 default
  readonly supportsAbort = false;

  async embed(_texts: string[]): Promise<number[][]> {
    throw new Error('ChromaDB handles embeddings internally. Use addDocuments() directly.');
  }
}

/**
 * Ollama local embeddings
 */
export class OllamaEmbeddings implements EmbeddingProvider {
  readonly name = 'ollama';
  readonly supportsAbort = true;
  dimensions: number;
  readonly dimensionKnown: boolean;
  private baseUrl: string;
  private model: string;
  private _dimensionsDetected = false;

  private normalizeForDotDistance(vector: number[]): number[] {
    if (!/(^|\/)bge-m3(?::|$)/.test(this.model)) return vector;
    let squaredNorm = 0;
    for (const value of vector) squaredNorm += value * value;
    const norm = Math.sqrt(squaredNorm);
    if (!Number.isFinite(norm) || norm <= 0) {
      throw new Error('Ollama bge-m3 returned a vector with invalid L2 norm');
    }
    return vector.map((value) => value / norm);
  }

  constructor(config: { baseUrl?: string; model?: string } = {}) {
    this.baseUrl = config.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    this.model = config.model || 'nomic-embed-text';
    // Known model dimensions (fallback before auto-detect)
    const KNOWN_DIMS: Record<string, number> = {
      'nomic-embed-text': 768,
      'qwen3-embedding': 4096,
      'bge-m3': 1024,
      'mxbai-embed-large': 1024,
      'all-minilm': 384,
    };
    this.dimensionKnown = this.model in KNOWN_DIMS;
    // Keep generic legacy callers compatible; A2 uses dimensionKnown/probes.
    this.dimensions = KNOWN_DIMS[this.model] || 768;
  }

  async embed(texts: string[], _type?: 'query' | 'passage', signal?: AbortSignal): Promise<number[][]> {
    const embeddings: number[][] = [];

    for (const text of texts) {
      // Truncate to ~2000 chars — Thai text uses 2-3x more tokens than English
      const truncated = text.length > 2000 ? text.slice(0, 2000) : text;
      const response = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: truncated }),
        signal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new EmbeddingProviderHttpError(response.status, `Ollama API error: ${error}`);
      }

      const data = await response.json() as { embedding: number[] };
      const embedding = this.normalizeForDotDistance(data.embedding);
      embeddings.push(embedding);

      // Auto-detect dimensions from first response
      if (!this._dimensionsDetected && embedding.length > 0) {
        this.dimensions = embedding.length;
        this._dimensionsDetected = true;
      }
    }

    return embeddings;
  }
}

/**
 * OpenAI embeddings via API
 */
export class OpenAIEmbeddings implements EmbeddingProvider {
  readonly name = 'openai';
  readonly supportsAbort = true;
  readonly dimensions: number;
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: { apiKey?: string; model?: string; baseUrl?: string } = {}) {
    this.apiKey = config.apiKey || process.env.ORACLE_OPENAI_API_KEY || process.env.OPENAI_API_KEY || '';
    this.baseUrl = config.baseUrl || process.env.ORACLE_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    this.model = config.model || 'text-embedding-3-small';

    // Known model dimensions
    const KNOWN_DIMS: Record<string, number> = {
      'text-embedding-3-large': 3072,
      'text-embedding-3-small': 1536,
      'BAAI/bge-m3': 1024,
      'bge-m3': 1024,
    };
    this.dimensions = KNOWN_DIMS[this.model] || 1536;

    if (!this.apiKey) {
      throw new Error('OpenAI API key required. Set OPENAI_API_KEY.');
    }
  }

  async embed(texts: string[], _type?: 'query' | 'passage', signal?: AbortSignal): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: texts, model: this.model }),
      signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new EmbeddingProviderHttpError(response.status, `OpenAI API error: ${error}`);
    }

    const data = await response.json() as {
      data: { embedding: number[]; index: number }[];
    };

    return data.data
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding);
  }
}

/**
 * Create embedding provider from type string
 */
export function createEmbeddingProvider(
  type: EmbeddingProviderType = 'chromadb-internal',
  model?: string
): EmbeddingProvider {
  switch (type) {
    case 'ollama':
      return new OllamaEmbeddings({ model });
    case 'openai':
      return new OpenAIEmbeddings({ model });
    case 'cloudflare-ai': {
      // Dynamic import to avoid requiring CF credentials when not used
      const { CloudflareAIEmbeddings } = require('./adapters/cloudflare-vectorize.ts');
      return new CloudflareAIEmbeddings({ model });
    }
    case 'chromadb-internal':
    default:
      return new ChromaDBInternalEmbeddings();
  }
}
