import { expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { persistAsyncLearning } from '../../src/learn/persistence.ts';
import { LanceDBAdapter } from '../../src/vector/adapters/lancedb.ts';
import type { EmbeddingProvider } from '../../src/vector/types.ts';
import type { EmbeddingModelPreset } from '../../src/vector/config.ts';
import { a2Runtime, cleanupRuntime, startService } from './arra-learn-process-harness.ts';

class InspectEmbedder implements EmbeddingProvider {
  readonly name = 'inspect';
  readonly dimensions = 3;
  readonly supportsAbort = true;
  async embed(): Promise<number[][]> { return [[1, 0, 0]]; }
}

test('real worker daemon probes a custom model and moves pending to one plain-ID Lance row', async () => {
  const runtime = a2Runtime('arra-a2-worker-daemon');
  const fake = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: async (request) => {
      const body = await request.json() as { model?: string };
      if (body.model !== 'custom-three') return new Response('wrong model', { status: 400 });
      return Response.json({ embedding: [0.1, 0.2, 0.3] });
    },
  });
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let inspection: LanceDBAdapter | undefined;
  try {
    const models: Record<string, EmbeddingModelPreset> = {
      custom: {
        collection: 'custom_vectors', model: 'custom-three', provider: 'ollama',
        dimension: 3, metadataSchemaVersion: 1, supportsAbort: true,
        supportsPrecomputedUpsert: true, dataPath: path.join(runtime.dataDir, 'lancedb'),
      },
    };
    fs.writeFileSync(path.join(runtime.dataDir, 'vector-server.json'), JSON.stringify({
      version: '1', host: '127.0.0.1', port: 0, dataPath: path.join(runtime.dataDir, 'lancedb'),
      embeddingEndpoint: `http://127.0.0.1:${fake.port}`,
      collections: { custom: { ...models.custom, primary: true } },
    }));
    Object.assign(runtime.env, {
      ORACLE_INDEXER_WORKERS_ENABLED: '1', ORACLE_EMBEDDING_MODEL_KEY: 'custom',
      ORACLE_EMBEDDING_MODEL: 'custom-three', OLLAMA_BASE_URL: `http://127.0.0.1:${fake.port}`,
      INDEXER_HOST: '127.0.0.1', INDEXER_PORT: String(runtime.port),
    });
    const { createDatabase } = await import('../../src/db/index.ts');
    const { sqlite: db } = createDatabase(runtime.dbPath);
    db.exec('PRAGMA synchronous = FULL');
    const learned = await persistAsyncLearning({
      sqlite: db, learningDir: path.join(runtime.repoRoot, 'ψ/memory/learnings'),
      sourceFilePrefix: 'ψ/memory/learnings', models, env: runtime.env,
    }, { pattern: 'custom non 768 worker startup probe' });
    db.close();
    service = await startService(runtime, 'src/indexer/daemon.ts', `${runtime.baseUrl}/health`, {
      ORACLE_TEST_ALLOWED_PORTS: `${runtime.port},${fake.port}`,
    });
    const deadline = Date.now() + 15_000;
    let status = 'pending';
    while (status !== 'done' && Date.now() < deadline) {
      await Bun.sleep(50);
      const check = new Database(runtime.dbPath, { readonly: true });
      status = (check.query('SELECT status FROM indexing_jobs_v2').get() as { status: string }).status;
      check.close();
    }
    expect(status).toBe('done');
    inspection = new LanceDBAdapter('custom_vectors', path.join(runtime.dataDir, 'lancedb'), new InspectEmbedder());
    await inspection.connect();
    await inspection.ensureCollection(3);
    const rows = await inspection.getDocumentTexts();
    expect(rows).toEqual([{ id: learned.id, text: expect.stringContaining('custom non 768') }]);
  } finally {
    if (service) await service.stop().catch(() => {});
    if (inspection) await inspection.close().catch(() => {});
    fake.stop(true);
    cleanupRuntime(runtime);
  }
}, 45_000);
