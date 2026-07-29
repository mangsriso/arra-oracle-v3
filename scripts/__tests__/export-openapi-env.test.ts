import { describe, expect, test } from 'bun:test';
import { buildExportOpenApiEnv, exportOpenApiPaths } from '../export-openapi-env.ts';

describe('OpenAPI export environment', () => {
  test('isolates writable paths and drops production credentials and providers', () => {
    const paths = exportOpenApiPaths('/tmp/export-fixture');
    const env = buildExportOpenApiEnv(paths, '48900', {
      PATH: '/usr/bin',
      BUN_INSTALL: '/tmp/bun',
      ORACLE_DATA_DIR: '/production/data',
      ORACLE_DB_PATH: '/production/oracle.db',
      ORACLE_REPO_ROOT: '/production/repo',
      ORACLE_OPENAI_API_KEY: 'must-not-pass',
      ORACLE_OPENAI_BASE_URL: 'https://external.example',
      ORACLE_EMBEDDING_PROVIDER: 'openai',
      VECTOR_URL: 'https://vector.example',
    });

    expect(env.HOME).toBe('/tmp/export-fixture/home');
    expect(env.ORACLE_DATA_DIR).toBe('/tmp/export-fixture/data');
    expect(env.ORACLE_DB_PATH).toBe('/tmp/export-fixture/data/oracle.db');
    expect(env.ORACLE_REPO_ROOT).toBe('/tmp/export-fixture/repo');
    expect(env.ORACLE_HOST).toBe('127.0.0.1');
    expect(env.ORACLE_PORT).toBe('48900');
    expect(env.ORACLE_DISABLE_LOCAL_VECTOR).toBe('true');
    expect(env.VECTOR_URL).toBe('');
    expect(env.MAW_JS_URL).toBe('http://127.0.0.1:9');
    expect(env.ORACLENET_URL).toBe('http://127.0.0.1:9');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.BUN_INSTALL).toBe('/tmp/bun');
    expect(env.ORACLE_OPENAI_API_KEY).toBeUndefined();
    expect(env.ORACLE_OPENAI_BASE_URL).toBeUndefined();
    expect(env.ORACLE_EMBEDDING_PROVIDER).toBeUndefined();
  });
});
