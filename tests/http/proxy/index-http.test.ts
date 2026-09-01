import { afterEach, describe, expect, test } from 'bun:test';
import { createHttpProxyClient } from '../../../src/index-http.ts';
import { cleanupProxyFixtures, startProxyFixture } from './proxy-fixture.ts';

afterEach(cleanupProxyFixtures);

function resultText(result: Awaited<ReturnType<ReturnType<
  typeof createHttpProxyClient
>['callTool']>>): string {
  return result.content[0]?.text ?? '';
}

describe('HTTP MCP proxy requests', () => {
  test('passes through fast success with the expected request shape', async () => {
    const expected = { content: [{ type: 'text', text: 'unchanged' }] };
    let observed: { method: string; path: string; contentType: string | null; body: unknown } | null = null;
    const config = startProxyFixture(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/api/health') return Response.json({ status: 'ok' });
      observed = {
        method: request.method,
        path,
        contentType: request.headers.get('content-type'),
        body: await request.json(),
      };
      return Response.json(expected);
    });

    const result = await createHttpProxyClient(config).callTool('arra_search', { query: 'safe' });

    expect(result).toEqual(expected);
    expect(observed).toEqual({
      method: 'POST',
      path: '/mcp/call',
      contentType: 'application/json',
      body: { name: 'arra_search', arguments: { query: 'safe' }, repoRoot: '' },
    });
  });

  test('uses learning-specific guidance only for a delayed arra_learn', async () => {
    const config = startProxyFixture(async (request) => {
      if (new URL(request.url).pathname === '/api/health') return Response.json({ status: 'ok' });
      await request.json();
      await Bun.sleep(1_000);
      return Response.json({ content: [] });
    });

    const learning = resultText(await createHttpProxyClient(config).callTool('arra_learn', {
      pattern: 'SECRET_PAYLOAD_MUST_NOT_ECHO',
    }));
    const read = resultText(await createHttpProxyClient(config).callTool('arra_search', {
      query: 'PRIVATE_QUERY_MUST_NOT_ECHO',
    }));

    expect(learning).toMatch(/Tool "arra_learn" timed out after \d+ ms/);
    expect(learning).toContain('outcome may be unknown');
    expect(learning).toContain('Verify the deterministic learning ID/file before retrying');
    expect(learning).not.toContain('SECRET_PAYLOAD_MUST_NOT_ECHO');
    expect(read).toContain('Tool "arra_search" timed out');
    expect(read).toContain('Check the Oracle endpoint before retrying');
    expect(read).not.toContain('deterministic learning ID/file');
    expect(read).not.toContain('PRIVATE_QUERY_MUST_NOT_ECHO');
  });

  test('preserves HTTP 503 classification and unknown-outcome guidance for arra_learn', async () => {
    const config = startProxyFixture(async (request) => {
      if (new URL(request.url).pathname === '/api/health') return Response.json({ status: 'ok' });
      const body = await request.json() as { arguments?: { pattern?: string } };
      return new Response(`upstream failed for ${body.arguments?.pattern}`, { status: 503 });
    });
    const text = resultText(await createHttpProxyClient(config).callTool('arra_learn', {
      pattern: 'PRIVATE_LEARNING',
    }));

    expect(text).toContain('HTTP 503: upstream failed for [redacted]');
    expect(text).toContain('outcome may be unknown');
    expect(text).toContain('Verify the deterministic learning ID/file before retrying');
    expect(text).not.toContain('PRIVATE_LEARNING');
  });

  test('classifies a post-health network failure without echoing its message', async () => {
    let requests = 0;
    const fetchImpl = (async () => {
      requests += 1;
      if (requests === 1) return Response.json({ status: 'ok' });
      throw new TypeError('connection reset: SECRET_NETWORK_DETAIL');
    }) as typeof fetch;
    const client = createHttpProxyClient(
      { baseUrl: 'http://127.0.0.1:54321', timeoutMs: 100 },
      fetchImpl,
    );
    const text = resultText(await client.callTool('arra_learn', { pattern: 'PRIVATE' }));

    expect(text).toContain('network request failed after dispatch');
    expect(text).toContain('outcome may be unknown');
    expect(text).not.toContain('SECRET_NETWORK_DETAIL');
    expect(text).not.toContain('PRIVATE');
  });
});

describe('HTTP MCP proxy health cache', () => {
  test('rechecks health after a failed tool call', async () => {
    let healthChecks = 0;
    let calls = 0;
    const config = startProxyFixture((request) => {
      if (new URL(request.url).pathname === '/api/health') {
        healthChecks += 1;
        return Response.json({ status: 'ok' });
      }
      calls += 1;
      if (calls === 2) return new Response('temporary failure', { status: 502 });
      return Response.json({ content: [{ type: 'text', text: `call ${calls}` }] });
    });
    const client = createHttpProxyClient(config);

    expect(resultText(await client.callTool('arra_list'))).toBe('call 1');
    expect(resultText(await client.callTool('arra_list'))).toContain('HTTP 502');
    expect(resultText(await client.callTool('arra_list'))).toBe('call 3');
    expect(healthChecks).toBe(2);
  });

  test('rechecks health after listTools fails', async () => {
    let healthChecks = 0;
    let lists = 0;
    const config = startProxyFixture((request) => {
      if (new URL(request.url).pathname === '/api/health') {
        healthChecks += 1;
        return Response.json({ status: 'ok' });
      }
      lists += 1;
      if (lists === 2) return new Response('list failed', { status: 503 });
      return Response.json({ tools: [{ name: `tool-${lists}` }] });
    });
    const client = createHttpProxyClient(config);

    expect(await client.listTools()).toEqual({ tools: [{ name: 'tool-1' }] });
    await expect(client.listTools()).rejects.toThrow('HTTP 503');
    expect(await client.listTools()).toEqual({ tools: [{ name: 'tool-3' }] });
    expect(healthChecks).toBe(2);
  });
});
