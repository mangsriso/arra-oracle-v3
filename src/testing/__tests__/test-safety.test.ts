import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertSafeTestRuntime } from '../test-safety.ts';

function safeEnv(root: string): Record<string, string> {
  const data = path.join(root, 'data');
  for (const dir of [path.join(root, 'home'), path.join(root, 'tmp'), data, path.join(root, 'repo')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return {
    ORACLE_TEST_MODE: 'strict',
    ORACLE_TEST_ROOT: root,
    ORACLE_SYSTEM_TMPDIR: os.tmpdir(),
    HOME: path.join(root, 'home'),
    TMPDIR: path.join(root, 'tmp'),
    ORACLE_DATA_DIR: data,
    ORACLE_DB_PATH: path.join(data, 'oracle.db'),
    ORACLE_REPO_ROOT: path.join(root, 'repo'),
    ORACLE_VECTOR_DB_PATH: path.join(data, 'lancedb'),
    ORACLE_HOST: '127.0.0.1',
    ORACLE_PORT: '51991',
    ORACLE_DISABLE_LOCAL_VECTOR: 'true',
    VECTOR_URL: '',
  };
}

describe('strict test runtime guard', () => {
  test('accepts an explicit temp-only runtime', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-safety-ok-'));
    try {
      expect(() => assertSafeTestRuntime(safeEnv(root))).not.toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects the production port before server startup', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-safety-port-'));
    try {
      const env = safeEnv(root);
      env.ORACLE_PORT = '47778';
      expect(() => assertSafeTestRuntime(env)).toThrow(/production Oracle port/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a production db path even when every other path is temporary', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-safety-db-'));
    try {
      const env = safeEnv(root);
      env.ORACLE_DB_PATH = '/home/aitma/.oracle-v2/oracle.db';
      expect(() => assertSafeTestRuntime(env)).toThrow(/refusing non-temp ORACLE_DB_PATH/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('resolves symlinks and rejects a temp-looking path that escapes temp', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-safety-link-'));
    try {
      const env = safeEnv(root);
      const escape = path.join(root, 'escape');
      fs.symlinkSync('/home', escape);
      env.ORACLE_REPO_ROOT = path.join(escape, 'aitma');
      expect(() => assertSafeTestRuntime(env)).toThrow(/refusing non-temp ORACLE_REPO_ROOT/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('blocks unregistered loopback services before a network call', () => {
    expect(() => fetch('http://127.0.0.1:11434/api/tags')).toThrow(
      /unregistered loopback endpoint/,
    );
  });
});
