import { expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { persistAsyncLearning } from '../../src/learn/persistence.ts';
import { learnHarness } from '../../src/learn/__tests__/fixture.ts';
import { LanceDBAdapter } from '../../src/vector/adapters/lancedb.ts';
import type { EmbeddingProvider } from '../../src/vector/types.ts';

const projectRoot = path.resolve(import.meta.dir, '../..');
const guard = path.join(projectRoot, 'tests/support/process-network-guard.ts');
const worker = path.join(projectRoot, 'tests/e2e/fixtures/arra-worker-child.ts');

class InspectEmbedder implements EmbeddingProvider {
  readonly name = 'inspect-only';
  readonly dimensions = 3;
  readonly supportsAbort = true;
  async embed(): Promise<number[][]> { throw new Error('inspection must not embed'); }
}

function childEnv(root: string, dbPath: string, lancePath: string, mode: string) {
  const dirs = {
    home: `${root}/home`, temp: `${root}/tmp`, data: `${root}/data`, vector: `${root}/vector`,
  };
  Object.values(dirs).forEach((directory) => fs.mkdirSync(directory, { recursive: true }));
  return {
    ...process.env,
    HOME: dirs.home,
    TMPDIR: dirs.temp,
    ORACLE_TEST_MODE: 'strict',
    ORACLE_TEST_ROOT: root,
    ORACLE_SYSTEM_TMPDIR: process.env.ORACLE_SYSTEM_TMPDIR || os.tmpdir(),
    ORACLE_DATA_DIR: dirs.data,
    ORACLE_DB_PATH: dbPath,
    ORACLE_REPO_ROOT: root,
    ORACLE_VECTOR_DB_PATH: dirs.vector,
    ORACLE_DISABLE_LOCAL_VECTOR: 'true',
    ORACLE_HOST: '127.0.0.1',
    ORACLE_PORT: '55431',
    VECTOR_URL: '',
    ORACLE_TEST_ALLOWED_PORTS: '',
    A2_WORKER_MODE: mode,
    A2_LANCE_PATH: lancePath,
  } as Record<string, string>;
}

async function spawnWorker(env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, '--preload', guard, worker], {
    cwd: projectRoot, env, stdout: 'pipe', stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    child.stdout ? new Response(child.stdout).text() : '',
    child.stderr ? new Response(child.stderr).text() : '',
  ]);
  return { exitCode, output: `${stdout}\n${stderr}` };
}

test('SIGKILL after real Lance upsert reclaims expired lease and replays to one row', async () => {
  const h = await learnHarness();
  const lancePath = `${h.root}/lance`;
  let inspection: LanceDBAdapter | undefined;
  try {
    const learned = await persistAsyncLearning(h.deps, {
      pattern: 'process crash after durable vector commit',
      concepts: ['lease', 'replay'],
      source: 'A2 child termination test',
      project: 'github.com/example/process-crash',
    });
    expect(learned.success).toBe(true);
    h.db.close();

    const crash = await spawnWorker(childEnv(h.root, `${h.root}/oracle.db`, lancePath, 'crash'));
    expect(crash.exitCode).not.toBe(0);
    const claimedDb = new Database(`${h.root}/oracle.db`);
    const claimed = claimedDb.query(
      'SELECT status, attempts, lease_until FROM indexing_jobs_v2',
    ).get() as { status: string; attempts: number; lease_until: number };
    if (claimed.status !== 'claimed') throw new Error(`crash child did not claim the job:\n${crash.output}`);
    expect(claimed.status).toBe('claimed');
    expect(claimed.attempts).toBe(1);
    claimedDb.close();
    while (Date.now() <= claimed.lease_until) await Bun.sleep(10);

    const replay = await spawnWorker(childEnv(h.root, `${h.root}/oracle.db`, lancePath, 'replay'));
    expect(replay.exitCode).toBe(0);
    const finalDb = new Database(`${h.root}/oracle.db`, { readonly: true });
    expect(finalDb.query('SELECT status FROM indexing_jobs_v2').get()).toEqual({ status: 'done' });
    expect((finalDb.query('SELECT COUNT(*) AS n FROM indexing_job_attempts_v2').get() as { n: number }).n)
      .toBe(2);
    finalDb.close();

    inspection = new LanceDBAdapter('learn_test_vectors', lancePath, new InspectEmbedder());
    await inspection.connect();
    const rows = await inspection.getDocumentTexts();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(learned.id);
  } finally {
    await inspection?.close().catch(() => {});
    fs.rmSync(h.root, { recursive: true, force: true });
  }
}, 20_000);

test('hung upsert owner exits at deadline before lease reclaim and plain-ID replay', async () => {
  const h = await learnHarness();
  const lancePath = `${h.root}/lance-hung`;
  let inspection: LanceDBAdapter | undefined;
  try {
    const learned = await persistAsyncLearning(h.deps, {
      pattern: 'hung external write is process-bounded', concepts: ['timeout', 'fence'],
    });
    h.db.close();
    const started = performance.now();
    const hung = await spawnWorker(childEnv(h.root, `${h.root}/oracle.db`, lancePath, 'hang'));
    expect(hung.exitCode).toBe(70);
    expect(performance.now() - started).toBeLessThan(2_000);
    const claimedDb = new Database(`${h.root}/oracle.db`);
    const claim = claimedDb.query(
      'SELECT status, attempts, lease_until FROM indexing_jobs_v2',
    ).get() as { status: string; attempts: number; lease_until: number };
    expect(claim.status).toBe('claimed');
    while (Date.now() <= claim.lease_until) await Bun.sleep(10);
    claimedDb.close();
    const replay = await spawnWorker(childEnv(h.root, `${h.root}/oracle.db`, lancePath, 'replay'));
    expect(replay.exitCode).toBe(0);
    const finalDb = new Database(`${h.root}/oracle.db`, { readonly: true });
    expect(finalDb.query('SELECT status, attempts FROM indexing_jobs_v2').get())
      .toEqual({ status: 'done', attempts: 2 });
    finalDb.close();
    inspection = new LanceDBAdapter('learn_test_vectors', lancePath, new InspectEmbedder());
    await inspection.connect();
    const rows = await inspection.getDocumentTexts();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(learned.id);
  } finally {
    await inspection?.close().catch(() => {});
    fs.rmSync(h.root, { recursive: true, force: true });
  }
}, 20_000);
