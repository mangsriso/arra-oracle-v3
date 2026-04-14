import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

type ToolResponse = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

const HTTP_BASE_URL = 'http://localhost:47778';
const REQUEST_TIMEOUT_MS = 30_000;

let healthChecked = false;

function resetHealthChecked() {
  healthChecked = false;
}

function errorResponse(message: string): ToolResponse {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

async function fetchJson(path: string, body: unknown) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${HTTP_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(text || `HTTP ${response.status}`);
    }

    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timeout);
  }
}

async function ensureHealthy(): Promise<boolean> {
  if (healthChecked) return true;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${HTTP_BASE_URL}/api/health`, {
      signal: controller.signal,
    });

    if (!response.ok) return false;

    const health = await response.json() as { status?: string };
    if (health.status !== 'ok') return false;

    healthChecked = true;
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

const server = new Server(
  { name: 'arra-oracle-v2-http-proxy', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const healthy = await ensureHealthy();
  if (!healthy) {
    return { tools: [] };
  }
  const response = await fetchJson('/mcp/tools', {});
  return { tools: Array.isArray(response.tools) ? response.tools : [] };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const healthy = await ensureHealthy();
  if (!healthy) {
    return errorResponse('Oracle HTTP server not running — run startup.sh');
  }

  try {
    return await fetchJson('/mcp/call', {
      name: request.params.name,
      arguments: request.params.arguments ?? {},
      repoRoot: process.cwd(),
    }) as ToolResponse;
  } catch (error) {
    resetHealthChecked();
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(`Error: ${message}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
