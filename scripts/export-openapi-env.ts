import { join } from 'node:path';

export interface ExportOpenApiPaths {
  root: string;
  home: string;
  data: string;
  database: string;
  repo: string;
  temporary: string;
}

export function exportOpenApiPaths(root: string): ExportOpenApiPaths {
  const data = join(root, 'data');
  return {
    root,
    home: join(root, 'home'),
    data,
    database: join(data, 'oracle.db'),
    repo: join(root, 'repo'),
    temporary: join(root, 'tmp'),
  };
}

export function buildExportOpenApiEnv(
  paths: ExportOpenApiPaths,
  port: string,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    HOME: paths.home,
    TMPDIR: paths.temporary,
    NODE_ENV: 'development',
    ORACLE_TEST_MODE: 'strict',
    ORACLE_TEST_ROOT: paths.root,
    ORACLE_SYSTEM_TMPDIR: source.ORACLE_SYSTEM_TMPDIR || '/tmp',
    ORACLE_HOST: '127.0.0.1',
    ORACLE_PORT: port,
    ORACLE_DATA_DIR: paths.data,
    ORACLE_DB_PATH: paths.database,
    ORACLE_REPO_ROOT: paths.repo,
    ORACLE_VECTOR_DB: 'lancedb',
    ORACLE_VECTOR_DB_PATH: join(paths.data, 'lancedb'),
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
  };
  for (const key of ['PATH', 'BUN_INSTALL']) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}
