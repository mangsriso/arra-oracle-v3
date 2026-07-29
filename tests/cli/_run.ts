/**
 * CLI subprocess helper — spawns arra-cli with isolated env and captures output.
 *
 * Defaults:
 *   - ORACLE_API: the owned isolated HTTP fixture (never caller-overridable)
 *   - HOME: caller-controlled temp path for plugin-list isolation
 */
import { join } from "path";
import { assertSafeTestRuntime } from "../../src/testing/test-safety.ts";

const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const CLI_ENTRY = join(REPO_ROOT, "cli/src/cli.ts");

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
  const childEnv = { ...process.env, ...env };
  for (const key of [
    'ORACLE_TEST_MODE',
    'ORACLE_TEST_ROOT',
    'ORACLE_SYSTEM_TMPDIR',
    'ORACLE_HOST',
    'ORACLE_PORT',
    'ORACLE_DATA_DIR',
    'ORACLE_DB_PATH',
    'ORACLE_REPO_ROOT',
    'ORACLE_VECTOR_DB',
    'ORACLE_VECTOR_DB_PATH',
    'ORACLE_DISABLE_LOCAL_VECTOR',
    'ORACLE_API',
    'VECTOR_URL',
    'MAW_JS_URL',
    'ORACLENET_URL',
    'OLLAMA_BASE_URL',
    'QDRANT_URL',
    'ORACLE_OPENAI_BASE_URL',
    'OPENAI_BASE_URL',
  ]) {
    const safeValue = process.env[key];
    if (safeValue === undefined) delete childEnv[key];
    else childEnv[key] = safeValue;
  }
  assertSafeTestRuntime(childEnv, childEnv.ORACLE_SYSTEM_TMPDIR);
  const api = new URL(childEnv.ORACLE_API || '');
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname)
    || api.port === '47778'
  ) {
    throw new Error(`[test-safety] refusing CLI endpoint: ${api.origin}`);
  }
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { stdout, stderr, code };
}

export function tryParseJson(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
