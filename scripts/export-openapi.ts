#!/usr/bin/env bun
/**
 * Export the Elysia /swagger/json spec to docs/openapi.json.
 *
 * Spawns `bun src/server.ts` on a scratch port, polls until /health
 * responds, fetches /swagger/json, writes the file, then kills the
 * subprocess. Exits non-zero on any failure.
 *
 *   bun scripts/export-openapi.ts
 *   bun scripts/export-openapi.ts --port 48900 --out docs/openapi.json
 */

import { spawn } from 'bun';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildExportOpenApiEnv, exportOpenApiPaths } from './export-openapi-env.ts';

const args = parseArgs(process.argv.slice(2));
const PORT = args.port ?? '48900';
const OUT = resolve(args.out ?? 'docs/openapi.json');
const BOOT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 200;
const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const sandbox = exportOpenApiPaths(await mkdtemp(join(tmpdir(), 'oracle-openapi-')));

let child: ReturnType<typeof spawn> | null = null;

const shutdown = async (code: number): Promise<never> => {
  try {
    if (child) {
      child.kill('SIGTERM');
      await Promise.race([
        child.exited,
        new Promise((r) => setTimeout(r, 3000)),
      ]);
      if (!child.killed) child.kill('SIGKILL');
    }
  } catch {}
  await rm(sandbox.root, { recursive: true, force: true }).catch(() => {});
  process.exit(code);
};

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));

try {
  await Promise.all([
    mkdir(sandbox.home, { recursive: true }),
    mkdir(sandbox.data, { recursive: true }),
    mkdir(sandbox.repo, { recursive: true }),
    mkdir(sandbox.temporary, { recursive: true }),
  ]);
  child = spawn({
    cmd: [process.execPath, 'src/server.ts'],
    cwd: PROJECT_ROOT,
    env: buildExportOpenApiEnv(sandbox, PORT),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  await waitForServer(`http://127.0.0.1:${PORT}/`, BOOT_TIMEOUT_MS);

  const res = await fetch(`http://127.0.0.1:${PORT}/swagger/json`);
  if (!res.ok) throw new Error(`fetch /swagger/json failed: ${res.status}`);
  const spec = await res.json();

  validateOpenAPI3(spec);

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(spec, null, 2) + '\n', 'utf8');

  console.log(`✓ wrote ${OUT}`);
  console.log(`  openapi: ${spec.openapi}`);
  console.log(`  title:   ${spec.info?.title}`);
  console.log(`  version: ${spec.info?.version}`);
  console.log(`  paths:   ${Object.keys(spec.paths ?? {}).length}`);

  await shutdown(0);
} catch (err) {
  console.error('✗ export-openapi failed:', err instanceof Error ? err.message : err);
  await shutdown(1);
}

function parseArgs(argv: string[]): { port?: string; out?: string } {
  const out: { port?: string; out?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = argv[++i];
    else if (a === '--out') out.out = argv[++i];
  }
  return out;
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`server did not become ready on ${url} within ${timeoutMs}ms`);
}

function validateOpenAPI3(spec: any): void {
  if (!spec || typeof spec !== 'object') throw new Error('spec is not an object');
  if (typeof spec.openapi !== 'string' || !spec.openapi.startsWith('3.'))
    throw new Error(`openapi field must start with "3.", got ${JSON.stringify(spec.openapi)}`);
  if (!spec.info || typeof spec.info.title !== 'string' || typeof spec.info.version !== 'string')
    throw new Error('info.title and info.version are required');
  if (!spec.paths || typeof spec.paths !== 'object')
    throw new Error('paths object is required');
}
