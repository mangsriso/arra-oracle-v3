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
    ORACLE_HOST: '127.0.0.1',
    ORACLE_PORT: port,
    ORACLE_DATA_DIR: paths.data,
    ORACLE_DB_PATH: paths.database,
    ORACLE_REPO_ROOT: paths.repo,
    ORACLE_DISABLE_LOCAL_VECTOR: 'true',
    VECTOR_URL: '',
    MAW_JS_URL: 'http://127.0.0.1:9',
    ORACLENET_URL: 'http://127.0.0.1:9',
  };
  for (const key of ['PATH', 'BUN_INSTALL']) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}
