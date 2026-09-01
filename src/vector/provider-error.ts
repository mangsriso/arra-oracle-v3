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
