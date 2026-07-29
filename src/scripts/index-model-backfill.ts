import type {
  StoredDocumentText,
  VectorDocument,
  VectorStoreAdapter,
} from '../vector/types.ts';

export interface IncrementalVectorStore extends VectorStoreAdapter {
  upsertDocuments(docs: VectorDocument[]): Promise<void>;
  getDocumentTexts(): Promise<StoredDocumentText[]>;
}

export interface BackfillPlan {
  skipped: number;
  inserts: VectorDocument[];
  upserts: VectorDocument[];
}

export interface IdVerification {
  expected: number;
  actual: number;
  missing: string[];
  unexpected: string[];
  duplicates: string[];
}

interface BackfillOptions {
  store: IncrementalVectorStore;
  sourceDocuments: VectorDocument[];
  sqliteIds: string[];
  modelKey: string;
  batchSize: number;
  providerConfigured: boolean;
  rebuild?: boolean;
  log?: (message: string) => void;
  reportError?: (message: string) => void;
  now?: () => number;
}

export interface BackfillResult extends BackfillPlan {
  verifiedIds: number;
  elapsedSeconds: number;
}

export function supportsIncrementalBackfill(
  store: VectorStoreAdapter,
): store is IncrementalVectorStore {
  return typeof store.upsertDocuments === 'function'
    && typeof store.getDocumentTexts === 'function';
}

export function hasConfiguredEmbeddingProvider(
  modelKey: string,
  env: Record<string, string | undefined>,
  config: { collections?: Record<string, { provider?: string }> } | null,
): boolean {
  return Boolean(
    env.ORACLE_EMBEDDING_PROVIDER?.trim()
    || config?.collections?.[modelKey]?.provider?.trim(),
  );
}

function duplicateIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates].sort();
}

export function classifyDocuments(
  source: VectorDocument[],
  stored: StoredDocumentText[],
): BackfillPlan {
  const duplicates = duplicateIds(stored.map(row => row.id));
  if (duplicates.length > 0) {
    throw new Error(
      `Collection contains duplicate IDs; incremental upsert is unsafe: ${duplicates.slice(0, 5).join(', ')}`,
    );
  }

  const storedText = new Map(stored.map(row => [row.id, row.text]));
  const sourceDuplicates = duplicateIds(source.map(doc => doc.id));
  if (sourceDuplicates.length > 0) {
    throw new Error(`SQLite source contains duplicate IDs: ${sourceDuplicates.slice(0, 5).join(', ')}`);
  }

  const plan: BackfillPlan = { skipped: 0, inserts: [], upserts: [] };
  for (const doc of source) {
    if (!storedText.has(doc.id)) {
      plan.inserts.push(doc);
    } else if (storedText.get(doc.id) === doc.document) {
      plan.skipped++;
    } else {
      plan.upserts.push(doc);
    }
  }
  return plan;
}

export function verifyUniqueIds(
  expectedIds: string[],
  stored: Array<{ id: string }>,
): IdVerification {
  const expectedDuplicates = duplicateIds(expectedIds);
  if (expectedDuplicates.length > 0) {
    throw new Error(`SQLite contains duplicate IDs: ${expectedDuplicates.slice(0, 5).join(', ')}`);
  }

  const storedIds = stored.map(row => row.id);
  const expected = new Set(expectedIds);
  const actual = new Set(storedIds);
  return {
    expected: expected.size,
    actual: actual.size,
    missing: [...expected].filter(id => !actual.has(id)).sort(),
    unexpected: [...actual].filter(id => !expected.has(id)).sort(),
    duplicates: duplicateIds(storedIds),
  };
}

function verificationError(label: string, result: IdVerification): Error | null {
  if (result.missing.length === 0
    && result.unexpected.length === 0
    && result.duplicates.length === 0) return null;

  const details = [
    result.missing.length && `missing=${result.missing.length} (${result.missing.slice(0, 5).join(', ')})`,
    result.unexpected.length && `unexpected=${result.unexpected.length} (${result.unexpected.slice(0, 5).join(', ')})`,
    result.duplicates.length && `duplicates=${result.duplicates.length} (${result.duplicates.slice(0, 5).join(', ')})`,
  ].filter(Boolean).join('; ');
  return new Error(`${label} unique-ID verification failed: ${details}`);
}

export async function runIncrementalBackfill(options: BackfillOptions): Promise<BackfillResult> {
  const {
    store, sourceDocuments, sqliteIds, modelKey, batchSize,
    providerConfigured, rebuild = false,
    log = console.log, reportError = console.error, now = Date.now,
  } = options;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error('Batch size must be a positive integer');
  }

  const sourceCheck = verifyUniqueIds(sqliteIds, sourceDocuments);
  const sourceError = verificationError('SQLite source query', sourceCheck);
  if (sourceError) throw sourceError;

  let connected = false;
  let operationError: unknown;
  const startedAt = now();
  try {
    await store.connect();
    connected = true;
    await store.ensureCollection();
    let stored = await store.getDocumentTexts();

    if (stored.length > 0 && !providerConfigured) {
      throw new Error(
        `Collection for ${modelKey} already holds data, but no embedding provider is configured. `
        + 'Set ORACLE_EMBEDDING_PROVIDER or collections.<model>.provider in vector-server.json.',
      );
    }

    if (rebuild) {
      log('Mode: full rebuild (--rebuild explicitly requested)');
      await store.deleteCollection();
      await store.ensureCollection();
      stored = [];
    } else {
      log('Mode: incremental');
    }

    const plan = classifyDocuments(sourceDocuments, stored);
    const changes = [
      ...plan.inserts.map(document => ({ kind: 'insert' as const, document })),
      ...plan.upserts.map(document => ({ kind: 'upsert' as const, document })),
    ];
    log(`Plan: skip=${plan.skipped}, insert=${plan.inserts.length}, upsert=${plan.upserts.length}`);

    const totalBatches = Math.ceil(changes.length / batchSize);
    let completed = 0;
    for (let offset = 0; offset < changes.length; offset += batchSize) {
      const batch = changes.slice(offset, offset + batchSize);
      const batchNumber = Math.floor(offset / batchSize) + 1;
      try {
        await store.upsertDocuments(batch.map(change => change.document));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reportError(`  Batch ${batchNumber}/${totalBatches} FAILED: ${message}`);
        throw new Error(
          `Backfill stopped after ${completed}/${changes.length} changed documents; `
          + 'rerun will pick up only outstanding rows.',
        );
      }
      completed += batch.length;

      const elapsed = Math.max((now() - startedAt) / 1000, 0.001);
      const rate = completed / elapsed;
      const eta = rate > 0 ? Math.ceil((changes.length - completed) / rate) : 0;
      log(
        `  Batch ${batchNumber}/${totalBatches} — ${completed}/${changes.length} changed docs`
        + ` — ${rate.toFixed(1)}/s — ETA ${eta}s`,
      );
    }

    const verification = verifyUniqueIds(sqliteIds, await store.getDocumentTexts());
    const finalError = verificationError('Post-backfill', verification);
    if (finalError) throw finalError;

    const elapsedSeconds = (now() - startedAt) / 1000;
    log('\n=== Done ===');
    log(`Skipped: ${plan.skipped} unchanged`);
    log(`Inserted: ${plan.inserts.length}`);
    log(`Upserted: ${plan.upserts.length}`);
    log(`Verified: ${verification.actual} unique IDs match SQLite`);
    log(`Time: ${elapsedSeconds.toFixed(1)}s`);
    return { ...plan, verifiedIds: verification.actual, elapsedSeconds };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (connected) {
      try {
        await store.close();
      } catch (closeError) {
        if (!operationError) throw closeError;
        reportError(`Failed to close vector store: ${closeError instanceof Error ? closeError.message : closeError}`);
      }
    }
  }
}
