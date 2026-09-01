import { afterEach, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { cleanupProxyFixtures, startProxyFixture } from './proxy-fixture.ts';

afterEach(cleanupProxyFixtures);

test('direct stdio entrypoint initializes and lists proxied tools', async () => {
  const requests: Array<{ method: string; path: string }> = [];
  const config = startProxyFixture((request) => {
    const pathName = new URL(request.url).pathname;
    requests.push({ method: request.method, path: pathName });
    if (pathName === '/api/health') return Response.json({ status: 'ok' });
    if (pathName === '/mcp/tools') {
      return Response.json({
        tools: [{
          name: 'fixture_tool',
          description: 'Hermetic fixture',
          inputSchema: { type: 'object', properties: {} },
        }],
      });
    }
    return new Response('not found', { status: 404 });
  }, 2_000);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['src/index-http.ts'],
    cwd: `${import.meta.dir}/../../..`,
    env: {
      ORACLE_HTTP_BASE_URL: config.baseUrl,
      ORACLE_HTTP_TIMEOUT_MS: String(config.timeoutMs),
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'proxy-entrypoint-test', version: '1.0.0' });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });

  try {
    await client.connect(transport);
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name)).toEqual(['fixture_tool']);
    expect(requests).toEqual([
      { method: 'GET', path: '/api/health' },
      { method: 'POST', path: '/mcp/tools' },
    ]);
  } catch (error) {
    throw new Error(`direct stdio smoke failed: ${String(error)}\n${stderr}`);
  } finally {
    await client.close().catch(() => {});
  }
}, 10_000);
