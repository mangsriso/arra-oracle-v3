import { expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {
  a2Runtime, cleanupRuntime, httpLearn, mcpLearn, startService,
} from './arra-learn-process-harness.ts';

const baseInput = {
  pattern: 'Cafe\u0301 process retry\r\nconverges across transports',
  concepts: ['durability', 'e2e'],
  idempotency_key: 'same-logical-learning',
};

async function configureVault(runtime: ReturnType<typeof a2Runtime>): Promise<string> {
  const initializer = await startService(runtime, 'src/server.ts', `${runtime.baseUrl}/api/health`);
  await initializer.stop();
  const vault = path.join(runtime.root, 'vault');
  const bin = path.join(runtime.root, 'bin');
  fs.mkdirSync(vault, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const initialized = Bun.spawnSync(['git', 'init', '-q', vault]);
  if (initialized.exitCode !== 0) throw new Error('failed to initialize hermetic vault');
  const ghq = path.join(bin, 'ghq');
  fs.writeFileSync(ghq, '#!/bin/sh\nprintf "%s\\n" "$ORACLE_TEST_VAULT_ROOT"\n', { mode: 0o700 });
  runtime.env.PATH = `${bin}:${runtime.env.PATH || ''}`;
  runtime.env.ORACLE_TEST_VAULT_ROOT = vault;
  const db = new Database(runtime.dbPath);
  db.prepare(`
    INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('vault_repo', 'example/vault', ?)
  `).run(Date.now());
  db.close();
  return vault;
}

async function configureMissingVault(runtime: ReturnType<typeof a2Runtime>): Promise<void> {
  const initializer = await startService(runtime, 'src/server.ts', `${runtime.baseUrl}/api/health`);
  await initializer.stop();
  const bin = path.join(runtime.root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const ghq = path.join(bin, 'ghq');
  fs.writeFileSync(ghq, '#!/bin/sh\nprintf "%s\\n" "/definitely/missing/arra-vault"\n', { mode: 0o700 });
  runtime.env.PATH = `${bin}:${runtime.env.PATH || ''}`;
  const db = new Database(runtime.dbPath);
  db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('vault_repo', 'missing/vault', ?)`)
    .run(Date.now());
  db.close();
}

for (const order of ['http-mcp', 'mcp-http'] as const) {
  test(`spawned ${order} identical retry converges to one durable learning`, async () => {
    const runtime = a2Runtime(`arra-a2-${order}`);
    let service: Awaited<ReturnType<typeof startService>> | undefined;
    try {
      const vault = await configureVault(runtime);
      const input = order === 'http-mcp'
        ? { ...baseInput, source: 'A2 hermetic process test', project: 'example/transport-order' }
        : { ...baseInput, source: 'A2 from github.com/example/transport-order' };
      let first: Record<string, any>;
      let second: Record<string, any>;
      if (order === 'http-mcp') {
        service = await startService(runtime, 'src/server.ts', `${runtime.baseUrl}/api/health`);
        const response = await httpLearn(runtime, input);
        expect(response.status).toBe(201);
        first = response.body;
        await service.stop();
        service = undefined;
        second = await mcpLearn(runtime, input);
      } else {
        first = await mcpLearn(runtime, input);
        service = await startService(runtime, 'src/server.ts', `${runtime.baseUrl}/api/health`);
        const response = await httpLearn(runtime, input);
        expect(response.status).toBe(200);
        second = response.body;
      }

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      expect([first.outcome, second.outcome].sort()).toEqual(['created', 'replayed']);
      expect(second.id).toBe(first.id);
      expect(second.file).toBe(first.file);
      expect(second.indexing.job_id).toBe(first.indexing.job_id);
      expect(second.durability.content_hash).toBe(first.durability.content_hash);

      const db = new Database(runtime.dbPath, { readonly: true });
      try {
        expect((db.query('SELECT COUNT(*) AS n FROM oracle_documents').get() as { n: number }).n)
          .toBe(1);
        expect((db.query('SELECT COUNT(*) AS n FROM oracle_fts').get() as { n: number }).n)
          .toBe(1);
        expect((db.query('SELECT COUNT(*) AS n FROM indexing_jobs_v2').get() as { n: number }).n)
          .toBe(1);
        expect((db.query('SELECT COUNT(*) AS n FROM learn_reservations_v2').get() as { n: number }).n)
          .toBe(1);
      } finally {
        db.close();
      }
      const roots = [
        `${runtime.repoRoot}/ψ/memory/learnings`,
        `${vault}/github.com/example/transport-order/ψ/memory/learnings`,
      ];
      const files = roots.flatMap((directory) => fs.existsSync(directory)
        ? fs.readdirSync(directory).filter((name) => name.endsWith('.md'))
          .map((name) => `${directory}/${name}`)
        : []);
      expect(files).toHaveLength(1);
      expect(fs.readFileSync(files[0], 'utf8')).toContain('converges across transports');
    } finally {
      if (service) await service.stop().catch(() => {});
      cleanupRuntime(runtime);
    }
  }, 45_000);
}

test('unsafe project traversal is rejected without writing outside the vault', async () => {
  const runtime = a2Runtime('arra-a2-project-escape');
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  try {
    const vault = await configureVault(runtime);
    service = await startService(runtime, 'src/server.ts', `${runtime.baseUrl}/api/health`);
    const response = await httpLearn(runtime, {
      pattern: 'must not escape', project: 'github.com/../..', source: 'security test',
    });
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ success: false, outcome: 'error' });
    expect(fs.readdirSync(vault).filter((entry) => entry.endsWith('.md'))).toHaveLength(0);
    const db = new Database(runtime.dbPath, { readonly: true });
    expect((db.query('SELECT COUNT(*) AS n FROM learn_reservations_v2').get() as { n: number }).n)
      .toBe(0);
    db.close();
  } finally {
    if (service) await service.stop().catch(() => {});
    cleanupRuntime(runtime);
  }
}, 45_000);

test('HTTP idempotency conflict is structured and preserves the first identity', async () => {
  const runtime = a2Runtime('arra-a2-http-conflict');
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  try {
    await configureVault(runtime);
    service = await startService(runtime, 'src/server.ts', `${runtime.baseUrl}/api/health`);
    const first = await httpLearn(runtime, {
      pattern: 'first HTTP identity', project: 'example/conflict', idempotency_key: 'same-key',
    });
    const conflict = await httpLearn(runtime, {
      pattern: 'different HTTP identity', project: 'example/conflict', idempotency_key: 'same-key',
    });
    expect(first.status).toBe(201);
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ success: false, outcome: 'conflict' });
    const db = new Database(runtime.dbPath, { readonly: true });
    expect((db.query('SELECT COUNT(*) AS n FROM learn_reservations_v2').get() as { n: number }).n)
      .toBe(1);
    db.close();
  } finally {
    if (service) await service.stop().catch(() => {});
    cleanupRuntime(runtime);
  }
}, 45_000);

test('legacy MCP uses configured project-scoped vault placement', async () => {
  const runtime = a2Runtime('arra-a2-legacy-vault');
  try {
    const vault = await configureVault(runtime);
    runtime.env.ORACLE_INDEXER_ENQUEUE = '0';
    runtime.env.ORACLE_LEARN_LEGACY_MODE = '1';
    const result = await mcpLearn(runtime, {
      pattern: 'legacy configured vault placement', project: 'Owner/Repo',
    });
    expect(result.success).toBe(true);
    expect(result.file).toStartWith('github.com/owner/repo/ψ/memory/learnings/');
    expect(fs.existsSync(path.join(vault, result.file))).toBe(true);
    expect(result.warning).toBeUndefined();
  } finally {
    cleanupRuntime(runtime);
  }
}, 45_000);

test('legacy MCP warns when configured vault cannot be resolved', async () => {
  const runtime = a2Runtime('arra-a2-legacy-missing-vault');
  try {
    await configureMissingVault(runtime);
    runtime.env.ORACLE_INDEXER_ENQUEUE = '0';
    runtime.env.ORACLE_LEARN_LEGACY_MODE = '1';
    const result = await mcpLearn(runtime, { pattern: 'legacy unresolved vault warning' });
    expect(result.success).toBe(true);
    expect(result.file).toStartWith('ψ/memory/learnings/');
    expect(result.warning).toBeTruthy();
  } finally {
    cleanupRuntime(runtime);
  }
}, 45_000);
