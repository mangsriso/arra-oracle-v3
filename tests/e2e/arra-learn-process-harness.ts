import type { Subprocess } from 'bun';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import { createIsolatedRuntime, type IsolatedRuntime } from '../support/isolated-http-server.ts';

const PROJECT_ROOT = path.resolve(import.meta.dir, '../..');
const NETWORK_GUARD = path.join(PROJECT_ROOT, 'tests/support/process-network-guard.ts');
const FORBIDDEN_PORTS = new Set([47778, 47779, 11434]);

interface TestNetworkRegistry {
  allow: (port: number) => void;
  release: (port: number) => void;
}

function registry(): TestNetworkRegistry {
  const value = (globalThis as typeof globalThis & {
    __oracleTestNetworkRegistry?: TestNetworkRegistry;
  }).__oracleTestNetworkRegistry;
  if (!value) throw new Error('test network registry is unavailable');
  return value;
}

export function a2Runtime(prefix: string): IsolatedRuntime {
  const runtime = createIsolatedRuntime(prefix);
  Object.assign(runtime.env, {
    ORACLE_INDEXER_ENQUEUE: '1',
    ORACLE_INDEXER_WORKERS_ENABLED: '0',
    ORACLE_EMBEDDING_MODEL_KEY: 'bge-m3',
    ORACLE_EMBEDDING_DEPLOYMENT_REVISION: 'a2-process-e2e-v1',
    ORACLE_LEARN_LEGACY_MODE: '0',
  });
  return runtime;
}

function childEnv(runtime: IsolatedRuntime, allowedPorts: number[] = []): Record<string, string> {
  for (const port of allowedPorts) {
    if (FORBIDDEN_PORTS.has(port)) throw new Error(`forbidden child port: ${port}`);
  }
  return {
    ...runtime.env,
    ORACLE_TEST_ALLOWED_PORTS: allowedPorts.join(','),
  };
}

export interface RunningService {
  child: Subprocess<'ignore', 'pipe', 'pipe'>;
  stop: () => Promise<string>;
}

export async function startService(
  runtime: IsolatedRuntime,
  entry: string,
  healthUrl: string,
  env: Record<string, string> = {},
): Promise<RunningService> {
  registry().allow(runtime.port);
  const child = Bun.spawn(
    [process.execPath, '--preload', NETWORK_GUARD, entry],
    {
      cwd: PROJECT_ROOT,
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      env: { ...childEnv(runtime, [runtime.port]), ...env },
    },
  );
  const stderrPromise = child.stderr
    ? new Response(child.stderr).text().catch(() => '')
    : Promise.resolve('');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return {
          child,
          stop: async () => {
            child.kill('SIGTERM');
            const exited = await Promise.race([
              child.exited.then(() => true).catch(() => true),
              Bun.sleep(2_000).then(() => false),
            ]);
            if (!exited) {
              child.kill('SIGKILL');
              await child.exited.catch(() => {});
              registry().release(runtime.port);
              throw new Error(`service required SIGKILL after SIGTERM: ${entry}`);
            }
            registry().release(runtime.port);
            return stderrPromise;
          },
        };
      }
    } catch {
      // Still booting.
    }
    await Bun.sleep(50);
  }
  child.kill();
  await child.exited.catch(() => {});
  registry().release(runtime.port);
  throw new Error(`service failed to start: ${entry}\n${await stderrPromise}`);
}

export async function httpLearn(runtime: IsolatedRuntime, input: Record<string, unknown>) {
  const response = await fetch(`${runtime.baseUrl}/api/learn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

export async function mcpLearn(runtime: IsolatedRuntime, input: Record<string, unknown>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--preload', NETWORK_GUARD, 'src/index.ts'],
    cwd: PROJECT_ROOT,
    env: childEnv(runtime),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'arra-learn-a2-e2e', version: '1.0.0' });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  try {
    await client.connect(transport);
    const response = await client.callTool({ name: 'arra_learn', arguments: input });
    const block = response.content.find((item) => item.type === 'text');
    if (!block || block.type !== 'text') throw new Error('MCP learn returned no text payload');
    return JSON.parse(block.text) as Record<string, any>;
  } catch (error) {
    throw new Error(`MCP learn failed: ${String(error)}\n${stderr}`);
  } finally {
    await client.close().catch(() => {});
  }
}

export function cleanupRuntime(runtime: IsolatedRuntime): void {
  fs.rmSync(runtime.root, { recursive: true, force: true });
}
