import { expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { persistAsyncLearning } from '../../src/learn/persistence.ts';
import { assertSafeTestRuntime } from '../../src/testing/test-safety.ts';
import type { EmbeddingModelPreset } from '../../src/vector/config.ts';
import {
  a2Runtime, cleanupRuntime, startService,
} from './arra-learn-process-harness.ts';

async function prepareEligibleJob(runtime: ReturnType<typeof a2Runtime>) {
  const { createDatabase } = await import('../../src/db/index.ts');
  const { sqlite: db } = createDatabase(runtime.dbPath);
  db.exec('PRAGMA synchronous = FULL');
  const models: Record<string, EmbeddingModelPreset> = {
    'bge-m3': {
      collection: 'oracle_knowledge_bge_m3', model: 'bge-m3', provider: 'ollama',
      dimension: 1024, metadataSchemaVersion: 1,
      supportsAbort: true, supportsPrecomputedUpsert: true,
      dataPath: path.join(runtime.dataDir, 'lancedb'),
    },
  };
  const result = await persistAsyncLearning({
    sqlite: db,
    learningDir: path.join(runtime.repoRoot, 'ψ/memory/learnings'),
    sourceFilePrefix: 'ψ/memory/learnings',
    models,
    env: runtime.env,
  }, {
    pattern: 'eligible backlog remains untouched while workers are disabled',
    concepts: ['disabled-mode'],
    source: 'A2 daemon E2E',
    project: 'github.com/example/disabled-daemon',
  });
  expect(result.success).toBe(true);
  db.close();
}

test('spawned disabled daemon performs zero claims and constructs no provider or Lance store', async () => {
  const runtime = a2Runtime('arra-a2-disabled-daemon');
  const lancePath = path.join(runtime.dataDir, 'lancedb');
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  try {
    assertSafeTestRuntime(runtime.env, process.env.ORACLE_SYSTEM_TMPDIR);
    await prepareEligibleJob(runtime);
    expect(fs.existsSync(lancePath)).toBe(false);

    Object.assign(runtime.env, {
      ORACLE_INDEXER_WORKERS_ENABLED: '0',
      ORACLE_EMBEDDING_PROVIDER: 'openai',
      ORACLE_EMBEDDING_MODEL: 'bge-m3',
      ORACLE_OPENAI_API_KEY: '',
      OPENAI_API_KEY: '',
      INDEXER_HOST: '127.0.0.1',
      INDEXER_PORT: String(runtime.port),
    });
    service = await startService(
      runtime, 'src/indexer/daemon.ts', `${runtime.baseUrl}/health`,
      { INDEXER_HOST: '127.0.0.1', INDEXER_PORT: String(runtime.port) },
    );
    const health = await (await fetch(`${runtime.baseUrl}/health`)).json() as Record<string, any>;
    expect(health.mode.workers_enabled).toBe(false);
    expect(health.queue_depth['bge-m3']).toBe(1);
    expect(fs.existsSync(lancePath)).toBe(false);
    await service.stop();
    service = undefined;

    const db = new Database(runtime.dbPath, { readonly: true });
    expect(db.query(
      'SELECT status, attempts, claim_token FROM indexing_jobs_v2',
    ).get()).toEqual({ status: 'pending', attempts: 0, claim_token: null });
    expect((db.query('SELECT COUNT(*) AS n FROM indexing_job_attempts_v2').get() as { n: number }).n)
      .toBe(0);
    db.close();
    expect(fs.existsSync(lancePath)).toBe(false);
  } finally {
    if (service) await service.stop().catch(() => {});
    cleanupRuntime(runtime);
  }
}, 30_000);

test('fresh producer-only daemon migrates and accepts an authoritative enqueue', async () => {
  const runtime = a2Runtime('arra-a2-producer-daemon');
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  try {
    Object.assign(runtime.env, {
      ORACLE_INDEXER_WORKERS_ENABLED: '0', INDEXER_HOST: '127.0.0.1',
      INDEXER_PORT: String(runtime.port),
    });
    service = await startService(runtime, 'src/indexer/daemon.ts', `${runtime.baseUrl}/health`, {
      INDEXER_HOST: '127.0.0.1', INDEXER_PORT: String(runtime.port),
    });
    const db = new Database(runtime.dbPath);
    const content = 'fresh producer projection';
    const hash = new Bun.CryptoHasher('sha256').update(content).digest('hex');
    db.prepare('INSERT INTO oracle_fts (id, content, concepts) VALUES (?, ?, ?)')
      .run('producer-doc', content, '');
    db.close();
    const response = await fetch(`${runtime.baseUrl}/index`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc_id: 'producer-doc', content_hash: hash, model_key: 'bge-m3' }),
    });
    expect(response.status).toBe(200);
    await service.stop();
    service = undefined;
    const check = new Database(runtime.dbPath, { readonly: true });
    expect(check.query('SELECT status, attempts FROM indexing_jobs_v2').get())
      .toEqual({ status: 'pending', attempts: 0 });
    expect((check.query('SELECT COUNT(*) AS n FROM indexing_job_attempts_v2').get() as { n: number }).n)
      .toBe(0);
    check.close();
  } finally {
    if (service) await service.stop().catch(() => {});
    cleanupRuntime(runtime);
  }
}, 30_000);

test('direct CLI migrates a fresh database before querying v2 status', async () => {
  const runtime = a2Runtime('arra-a2-fresh-cli');
  try {
    const guard = path.join(import.meta.dir, '../support/process-network-guard.ts');
    const child = Bun.spawn([
      process.execPath, '--preload', guard, 'src/indexer/arra-indexer.ts', 'status',
    ], {
      cwd: path.resolve(import.meta.dir, '../..'),
      env: { ...runtime.env, ORACLE_TEST_ALLOWED_PORTS: '' },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(stdout).toContain('queue empty');
    const db = new Database(runtime.dbPath, { readonly: true });
    expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'indexing_jobs_v2'`).get())
      .toEqual({ name: 'indexing_jobs_v2' });
    db.close();
  } finally {
    cleanupRuntime(runtime);
  }
}, 30_000);

test('test network guard rejects outbound and production-adjacent ports', () => {
  expect(() => fetch('https://example.com/a2-denied')).toThrow(/real network access is disabled/);
  const registry = (globalThis as typeof globalThis & {
    __oracleTestNetworkRegistry: { allow: (port: number) => void };
  }).__oracleTestNetworkRegistry;
  for (const port of [47778, 47779, 11434]) {
    expect(() => registry.allow(port)).toThrow(/refusing unsafe test port registration/);
    expect(() => fetch(`http://127.0.0.1:${port}/denied`)).toThrow(
      /unregistered loopback endpoint is disabled/,
    );
  }
});
