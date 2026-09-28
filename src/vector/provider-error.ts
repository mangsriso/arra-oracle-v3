export class EmbeddingProviderHttpError extends Error {
  readonly permanent: boolean;

  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'EmbeddingProviderHttpError';
    this.permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
  }
}

export function isPermanentProviderError(error: unknown): boolean {
  return error instanceof EmbeddingProviderHttpError && error.permanent;
}

/**
 * A 200 response whose `data` does not map one-to-one onto the inputs. Deliberately not an
 * EmbeddingProviderHttpError and without a `permanent` flag: the indexer worker retries it.
 * Seen in practice: a LiteLLM proxy (1.98.0) returning cache-served multi-input responses with
 * repeated indices and missing ones — trusting `index` then shifts every later vector.
 */
export class EmbeddingResponseShapeError extends Error {
  constructor(detail: string) {
    super(`Embedding response shape: ${detail}`);
    this.name = 'EmbeddingResponseShapeError';
  }
}

/**
 * Validate an OpenAI-style embeddings `data` array for `n` inputs and return the vectors in
 * input order. Requires exactly one entry per index 0..n-1 and non-empty, finite vectors of
 * one length. It cannot detect a well-formed response that carries the wrong vector content.
 */
export function assertEmbeddingResponseShape(data: unknown, n: number): number[][] {
  if (!Array.isArray(data)) throw new EmbeddingResponseShapeError('data is not an array');
  if (data.length !== n) throw new EmbeddingResponseShapeError(`${data.length} entries for ${n} inputs`);
  const out: number[][] = new Array(n);
  let dim = -1;
  for (let i = 0; i < n; i++) {
    const entry = data[i] as { index?: unknown; embedding?: unknown } | null | undefined;
    if (entry === null || typeof entry !== 'object') throw new EmbeddingResponseShapeError(`entry ${i} is not an object`);
    const { index, embedding } = entry;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= n) {
      throw new EmbeddingResponseShapeError(`entry ${i} has index ${String(index)} outside 0..${n - 1}`);
    }
    if (out[index] !== undefined) throw new EmbeddingResponseShapeError(`index ${index} repeated`);
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new EmbeddingResponseShapeError(`index ${index} has no embedding`);
    }
    if (dim === -1) dim = embedding.length;
    else if (embedding.length !== dim) throw new EmbeddingResponseShapeError(`index ${index} has ${embedding.length} dimensions, expected ${dim}`);
    for (let j = 0; j < embedding.length; j++) {
      if (typeof embedding[j] !== 'number' || !Number.isFinite(embedding[j])) {
        throw new EmbeddingResponseShapeError(`index ${index} has a non-finite value`);
      }
    }
    out[index] = embedding as number[];
  }
  return out;
}
