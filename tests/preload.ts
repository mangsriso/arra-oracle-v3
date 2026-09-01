import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertSafeTestRuntime } from '../src/testing/test-safety.ts';

const systemTmpDir = os.tmpdir();
const inheritedOraclePaths = [
  'ORACLE_DATA_DIR',
  'ORACLE_DB_PATH',
  'ORACLE_REPO_ROOT',
  'ORACLE_VECTOR_DB_PATH',
  'ORACLE_TEST_ROOT',
] as const;

for (const name of inheritedOraclePaths) {
  const value = process.env[name];
  if (!value) continue;
  const resolved = path.resolve(value);
  const relative = path.relative(path.resolve(systemTmpDir), resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`[test-safety] refusing inherited non-temp ${name}: ${resolved}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-bun-test-'));
const home = path.join(root, 'home');
const temporary = path.join(root, 'tmp');
const data = path.join(root, 'data');
const repo = path.join(root, 'repo');
for (const dir of [home, temporary, data, repo]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

Object.assign(process.env, {
  HOME: home,
  TMPDIR: temporary,
  ORACLE_TEST_MODE: 'strict',
  ORACLE_TEST_ROOT: root,
  ORACLE_SYSTEM_TMPDIR: systemTmpDir,
  ORACLE_HOST: '127.0.0.1',
  ORACLE_PORT: String(50_000 + (process.pid % 10_000)),
  ORACLE_DATA_DIR: data,
  ORACLE_DB_PATH: path.join(data, 'oracle.db'),
  ORACLE_REPO_ROOT: repo,
  ORACLE_VECTOR_DB: 'lancedb',
  ORACLE_VECTOR_DB_PATH: path.join(data, 'lancedb'),
  ORACLE_API: 'http://127.0.0.1:9',
  ORACLE_DISABLE_LOCAL_VECTOR: 'true',
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
});

assertSafeTestRuntime(process.env, systemTmpDir);

const realFetch = globalThis.fetch.bind(globalThis);
const allowedLoopbackPorts = new Map<number, number>();
const forbiddenTestPorts = new Set([47778, 47779, 11434]);
const networkRegistry = {
  allow(port: number) {
    if (!Number.isInteger(port) || port <= 0 || port > 65_535 || forbiddenTestPorts.has(port)) {
      throw new Error(`[test-safety] refusing unsafe test port registration: ${port}`);
    }
    allowedLoopbackPorts.set(port, (allowedLoopbackPorts.get(port) || 0) + 1);
  },
  release(port: number) {
    const count = allowedLoopbackPorts.get(port) || 0;
    if (count <= 1) allowedLoopbackPorts.delete(port);
    else allowedLoopbackPorts.set(port, count - 1);
  },
};
Object.defineProperty(globalThis, '__oracleTestNetworkRegistry', {
  value: networkRegistry,
  configurable: false,
  enumerable: false,
  writable: false,
});

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(
    typeof input === 'string' || input instanceof URL ? input : input.url,
  );
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (!loopback) {
    throw new Error(`[test-safety] real network access is disabled during tests: ${url.origin}`);
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!allowedLoopbackPorts.has(port)) {
    throw new Error(`[test-safety] unregistered loopback endpoint is disabled during tests: ${url.origin}`);
  }
  return realFetch(input as RequestInfo | URL, init);
}) as typeof fetch;

process.on('exit', () => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // A test failure must retain its original signal.
  }
});
