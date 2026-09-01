import { afterEach, describe, expect, test } from 'bun:test';
import { createHttpProxyClient } from '../../../src/index-http.ts';
import { cleanupProxyFixtures, startProxyFixture } from './proxy-fixture.ts';

afterEach(cleanupProxyFixtures);

function textOf(result: Awaited<ReturnType<ReturnType<
  typeof createHttpProxyClient
>['callTool']>>): string {
  return result.content[0]?.text ?? '';
}

describe('HTTP MCP proxy error-body safety', () => {
  test('normalizes bounded detail and redacts reflected arguments', async () => {
    const config = startProxyFixture(async (request) => {
      if (new URL(request.url).pathname === '/api/health') return Response.json({ status: 'ok' });
      const body = await request.json() as { arguments?: { query?: string; limit?: number } };
      return new Response(
        ` validation\n\t failed for ${body.arguments?.query} limit ${body.arguments?.limit} `,
        { status: 400 },
      );
    });
    const text = textOf(await createHttpProxyClient(config).callTool('arra_search', {
      query: 'PRIVATE QUERY',
      limit: 42,
    }));

    expect(text).toContain('HTTP 400: validation failed for [redacted] limit [redacted]');
    expect(text).not.toContain('PRIVATE QUERY');
    expect(text).not.toContain('42');
    expect(text).not.toMatch(/\s{2,}/);
  });

  test('does not surface an upstream error body beyond the byte cap', async () => {
    const config = startProxyFixture((request) => {
      if (new URL(request.url).pathname === '/api/health') return Response.json({ status: 'ok' });
      return new Response(`prefix ${'X'.repeat(10_000)} PRIVATE_TAIL`, { status: 400 });
    });
    const text = textOf(await createHttpProxyClient(config).callTool('arra_search', {
      query: 'PRIVATE_TAIL',
    }));

    expect(text).toContain('HTTP 400: upstream error detail omitted (body too large)');
    expect(text.length).toBeLessThan(300);
    expect(text).not.toContain('PRIVATE_TAIL');
    expect(text).not.toContain('XXXXX');
  });

  test('uses generic health wording for custom endpoints', async () => {
    const fetchImpl = (async () => new Response('unhealthy', { status: 503 })) as typeof fetch;
    const client = createHttpProxyClient(
      { baseUrl: 'https://oracle.example.test', timeoutMs: 100 },
      fetchImpl,
    );
    const text = textOf(await client.callTool('arra_list'));

    expect(text).toContain('endpoint is unavailable or unhealthy');
    expect(text).not.toContain('startup.sh');
    expect(text).not.toContain('not running');
  });
});
