import { afterEach, describe, expect, test } from 'bun:test';
import { fetchOracleNet, fetchOracleNetJson } from '../client.ts';
import { oraclenetRoutes } from '../index.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function request(path: string): Request {
  return new Request(`http://localhost${path}`);
}

describe('OracleNet client', () => {
  test('attaches the shared timeout signal and returns parsed JSON', async () => {
    let signal: AbortSignal | null = null;
    const mockedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal as AbortSignal;
      return Response.json({ items: [1] });
    }) as typeof fetch;

    const result = await fetchOracleNetJson('/fixture', mockedFetch);

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ items: [1] });
  });

  test('classifies timeout separately from other upstream failures', async () => {
    const timeoutFetch = (async () => {
      throw new DOMException('timed out', 'TimeoutError');
    }) as typeof fetch;
    const unavailableFetch = (async () => {
      throw new TypeError('connection refused');
    }) as typeof fetch;

    expect(await fetchOracleNet('/fixture', timeoutFetch)).toMatchObject({
      ok: false,
      kind: 'timeout',
    });
    expect(await fetchOracleNet('/fixture', unavailableFetch)).toMatchObject({
      ok: false,
      kind: 'unavailable',
    });
  });

  test('classifies a timeout while parsing the upstream body', async () => {
    const bodyTimeoutFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new DOMException('body timed out', 'TimeoutError');
      },
    })) as typeof fetch;

    expect(await fetchOracleNetJson('/fixture', bodyTimeoutFetch)).toMatchObject({
      ok: false,
      kind: 'timeout',
      status: 200,
    });
  });
});

describe('OracleNet route failure contract', () => {
  test('all proxy routes return stable 504 timeout responses', async () => {
    globalThis.fetch = (async () => {
      throw new DOMException('timed out', 'TimeoutError');
    }) as typeof fetch;

    for (const path of ['/feed', '/oracles', '/presence']) {
      const response = await oraclenetRoutes.handle(request(`/api/oraclenet${path}`));
      expect(response.status).toBe(504);
      expect(await response.json()).toEqual({
        error: 'OracleNet timed out',
        code: 'ORACLENET_TIMEOUT',
      });
    }
    const status = await oraclenetRoutes.handle(request('/api/oraclenet/status'));
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ online: false, reason: 'timeout' });
  });

  test('non-2xx upstream responses map to stable unavailable responses', async () => {
    globalThis.fetch = (async () => new Response('upstream failed', { status: 503 })) as typeof fetch;

    const response = await oraclenetRoutes.handle(request('/api/oraclenet/feed'));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'OracleNet unavailable',
      code: 'ORACLENET_UNAVAILABLE',
    });
    const status = await oraclenetRoutes.handle(request('/api/oraclenet/status'));
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ online: false, reason: 'unavailable' });
  });
});
