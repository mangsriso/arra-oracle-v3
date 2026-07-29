/** Exact acknowledgement required before a vector collection can be rebuilt. */
export const REINDEX_CONFIRMATION = 'REINDEX_DELETE_COLLECTION';

export function isReindexConfirmed(value: unknown): boolean {
  return value === REINDEX_CONFIRMATION;
}

export function isValidReindexBatchSize(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}
