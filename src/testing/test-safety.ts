import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ORACLE_DEFAULT_PORT } from '../const.ts';

const REQUIRED_TEMP_PATHS = [
  'HOME',
  'TMPDIR',
  'ORACLE_DATA_DIR',
  'ORACLE_DB_PATH',
  'ORACLE_REPO_ROOT',
  'ORACLE_VECTOR_DB_PATH',
] as const;

function physicalPath(pathname: string): string {
  const missing: string[] = [];
  let cursor = path.resolve(pathname);

  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }

  let resolved = fs.realpathSync(cursor);
  for (const part of missing) resolved = path.join(resolved, part);
  return path.resolve(resolved);
}

function isStrictChild(pathname: string, root: string): boolean {
  const relative = path.relative(root, pathname);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

/**
 * Fail before config.ts creates a directory or db/index.ts opens SQLite.
 *
 * ORACLE_TEST_MODE=strict is inherited by every test subprocess. A child that
 * forgets even one explicit temp path cannot silently fall back to user data.
 */
export function assertSafeTestRuntime(
  env: Record<string, string | undefined> = process.env,
  systemTmpDir: string = os.tmpdir(),
): void {
  if (env.ORACLE_TEST_MODE !== 'strict') return;

  const tempRoot = physicalPath(env.ORACLE_SYSTEM_TMPDIR || systemTmpDir);
  const testRoot = env.ORACLE_TEST_ROOT;
  if (!testRoot) throw new Error('[test-safety] ORACLE_TEST_ROOT is required in strict test mode');
  const resolvedTestRoot = physicalPath(testRoot);
  if (!isStrictChild(resolvedTestRoot, tempRoot)) {
    throw new Error(`[test-safety] refusing non-temp ORACLE_TEST_ROOT: ${resolvedTestRoot}`);
  }
  for (const name of REQUIRED_TEMP_PATHS) {
    const value = env[name];
    if (!value) throw new Error(`[test-safety] ${name} is required in strict test mode`);
    const resolved = physicalPath(value);
    if (!isStrictChild(resolved, tempRoot)) {
      throw new Error(`[test-safety] refusing non-temp ${name}: ${resolved}`);
    }
  }

  const port = Number(env.ORACLE_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`[test-safety] ORACLE_PORT must be an explicit non-zero test port: ${env.ORACLE_PORT || '(unset)'}`);
  }
  if (port === ORACLE_DEFAULT_PORT) {
    throw new Error(`[test-safety] refusing production Oracle port ${ORACLE_DEFAULT_PORT}`);
  }

  const host = env.ORACLE_HOST;
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error(`[test-safety] ORACLE_HOST must be loopback in strict test mode: ${host || '(unset)'}`);
  }
  if (env.ORACLE_DISABLE_LOCAL_VECTOR !== 'true') {
    throw new Error('[test-safety] ORACLE_DISABLE_LOCAL_VECTOR=true is required in strict test mode');
  }
  if (env.VECTOR_URL) {
    throw new Error(`[test-safety] VECTOR_URL must be disabled in strict test mode: ${env.VECTOR_URL}`);
  }
}

export const _physicalPathForTest = physicalPath;
