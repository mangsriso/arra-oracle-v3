export const DEFAULT_ORACLE_HOST = '127.0.0.1';

export function resolveOracleHost(value: string | undefined): string {
  const host = value?.trim();
  return host || DEFAULT_ORACLE_HOST;
}
