import type { Subprocess } from 'bun';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface IsolatedRuntime {
  root: string;
  home: string;
  temporary: string;
  dataDir: string;
  dbPath: string;
  repoRoot: string;
  port: number;
  baseUrl: string;
  env: Record<string, string>;
}

export interface IsolatedHttpServer extends IsolatedRuntime {
  process: Subprocess;
  stop: () => Promise<void>;
}

interface TestNetworkRegistry {
  allow: (port: number) => void;
  release: (port: number) => void;
}

function testNetworkRegistry(): TestNetworkRegistry | undefined {
  return (globalThis as typeof globalThis & {
    __oracleTestNetworkRegistry?: TestNetworkRegistry;
  }).__oracleTestNetworkRegistry;
}

function allocateLoopbackPort(): number {
  const reservation = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('reserved'),
  });
  const port = reservation.port;
  reservation.stop(true);
  if ([47778, 47779, 11434].includes(port)) return allocateLoopbackPort();
  return port;
}

export function createIsolatedRuntime(
  prefix: string,
  extraEnv: Record<string, string> = {},
): IsolatedRuntime {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const home = path.join(root, 'home');
  const temporary = path.join(root, 'tmp');
  const dataDir = path.join(root, 'data');
  const repoRoot = path.join(root, 'repo');
  const dbPath = path.join(dataDir, 'oracle.db');
  for (const dir of [home, temporary, dataDir, repoRoot]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const port = allocateLoopbackPort();
  return {
    root,
    home,
    temporary,
    dataDir,
    dbPath,
    repoRoot,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    env: {
      ...process.env,
      ...extraEnv,
      HOME: home,
      TMPDIR: temporary,
      ORACLE_TEST_MODE: 'strict',
      ORACLE_TEST_ROOT: root,
      ORACLE_SYSTEM_TMPDIR: process.env.ORACLE_SYSTEM_TMPDIR || os.tmpdir(),
      ORACLE_HOST: '127.0.0.1',
      ORACLE_PORT: String(port),
      ORACLE_DATA_DIR: dataDir,
      ORACLE_DB_PATH: dbPath,
      ORACLE_REPO_ROOT: repoRoot,
      ORACLE_VECTOR_DB: 'lancedb',
      ORACLE_VECTOR_DB_PATH: path.join(dataDir, 'lancedb'),
      ORACLE_DISABLE_LOCAL_VECTOR: 'true',
      ORACLE_LEARN_LEGACY_MODE: '1',
      ORACLE_EMBEDDING_PROVIDER: 'ollama',
      ORACLE_EMBEDDING_MODEL: 'bge-m3',
      VECTOR_URL: '',
      MAW_JS_URL: 'http://127.0.0.1:9',
      ORACLENET_URL: 'http://127.0.0.1:9',
      OLLAMA_BASE_URL: 'http://127.0.0.1:9',
      QDRANT_URL: 'http://127.0.0.1:9',
      ORACLE_OPENAI_BASE_URL: 'http://127.0.0.1:9',
      OPENAI_BASE_URL: 'http://127.0.0.1:9',
      ORACLE_OPENAI_API_KEY: '',
      OPENAI_API_KEY: '',
      CLOUDFLARE_API_TOKEN: '',
    } as Record<string, string>,
  };
}

export async function startIsolatedHttpServer(
  prefix: string,
  extraEnv: Record<string, string> = {},
): Promise<IsolatedHttpServer> {
  const runtime = createIsolatedRuntime(prefix, extraEnv);
  const projectRoot = path.resolve(import.meta.dir, '../..');
  testNetworkRegistry()?.allow(runtime.port);
  const child = Bun.spawn([process.execPath, 'src/server.ts'], {
    cwd: projectRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    env: runtime.env,
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${runtime.baseUrl}/api/health`);
      if (response.ok) {
        return {
          ...runtime,
          process: child,
          stop: async () => {
            try {
              child.kill();
              await child.exited.catch(() => {});
              fs.rmSync(runtime.root, { recursive: true, force: true });
            } finally {
              testNetworkRegistry()?.release(runtime.port);
            }
          },
        };
      }
    } catch {
      // Child is still booting.
    }
    await Bun.sleep(100);
  }

  child.kill();
  await child.exited.catch(() => {});
  const stderr = child.stderr ? await new Response(child.stderr).text().catch(() => '') : '';
  fs.rmSync(runtime.root, { recursive: true, force: true });
  testNetworkRegistry()?.release(runtime.port);
  throw new Error(`isolated Oracle server failed to start on ${runtime.baseUrl}\n${stderr}`);
}
