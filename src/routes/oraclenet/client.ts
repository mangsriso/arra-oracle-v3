import { ORACLENET_URL } from './model.ts';

export const ORACLENET_TIMEOUT_MS = 3000;

export type OracleNetFailureKind = 'timeout' | 'unavailable';

export type OracleNetResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: OracleNetFailureKind; status?: number };

export function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error) && !(error instanceof DOMException)) return false;
  return error.name === 'TimeoutError' || error.name === 'AbortError';
}

export async function fetchOracleNet(
  path: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs: number = ORACLENET_TIMEOUT_MS,
): Promise<OracleNetResult<Response>> {
  try {
    const response = await fetchImpl(`${ORACLENET_URL}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { ok: false, kind: 'unavailable', status: response.status };
    }
    return { ok: true, data: response };
  } catch (error) {
    return { ok: false, kind: isTimeoutError(error) ? 'timeout' : 'unavailable' };
  }
}

export async function fetchOracleNetJson(
  path: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs: number = ORACLENET_TIMEOUT_MS,
): Promise<OracleNetResult<unknown>> {
  const result = await fetchOracleNet(path, fetchImpl, timeoutMs);
  if (!result.ok) return result;
  try {
    return { ok: true, data: await result.data.json() };
  } catch (error) {
    return {
      ok: false,
      kind: isTimeoutError(error) ? 'timeout' : 'unavailable',
      status: result.data.status,
    };
  }
}

export function oracleNetFailure(kind: OracleNetFailureKind): {
  status: 502 | 504;
  body: { error: string; code: 'ORACLENET_TIMEOUT' | 'ORACLENET_UNAVAILABLE' };
} {
  if (kind === 'timeout') {
    return {
      status: 504,
      body: { error: 'OracleNet timed out', code: 'ORACLENET_TIMEOUT' },
    };
  }
  return {
    status: 502,
    body: { error: 'OracleNet unavailable', code: 'ORACLENET_UNAVAILABLE' },
  };
}
