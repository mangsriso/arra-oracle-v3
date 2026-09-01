import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

export type ToolResponse = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};
export type HttpProxyConfig = { baseUrl: string; timeoutMs: number };
export const DEFAULT_HTTP_BASE_URL = 'http://localhost:47778';
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_REQUEST_TIMEOUT_MS = 2_147_483_647;
export const MAX_ERROR_BODY_BYTES = 2_000;
export class ProxyHttpError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`HTTP ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'ProxyHttpError';
  }
}
export class ProxyTimeoutError extends Error {
  constructor(readonly elapsedMs: number) {
    super(`request timed out after ${elapsedMs} ms`);
    this.name = 'ProxyTimeoutError';
  }
}
class ProxyNetworkError extends Error {
  constructor() {
    super('network request failed after dispatch');
    this.name = 'ProxyNetworkError';
  }
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '[::1]' || host === '::1') return true;
  const octets = host.split('.').map(Number);
  return octets.length === 4
    && octets[0] === 127
    && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
}
function safeBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return DEFAULT_HTTP_BASE_URL;
  try {
    const url = new URL(value.trim());
    const protocolAllowed = url.protocol === 'https:'
      || (url.protocol === 'http:' && isLoopback(url.hostname));
    if (!protocolAllowed || url.username || url.password || url.href.includes('?') || url.href.includes('#')) {
      return DEFAULT_HTTP_BASE_URL;
    }
    return url.href.replace(/\/+$/, '');
  } catch {
    return DEFAULT_HTTP_BASE_URL;
  }
}

function safeTimeoutMs(value: unknown): number {
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value.trim())) return DEFAULT_REQUEST_TIMEOUT_MS;
  if (typeof value !== 'number' && typeof value !== 'string') return DEFAULT_REQUEST_TIMEOUT_MS;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_REQUEST_TIMEOUT_MS
    ? parsed
    : DEFAULT_REQUEST_TIMEOUT_MS;
}

export function normalizeHttpProxyConfig(
  config: { baseUrl?: unknown; timeoutMs?: unknown },
): HttpProxyConfig {
  return {
    baseUrl: safeBaseUrl(config.baseUrl),
    timeoutMs: safeTimeoutMs(config.timeoutMs),
  };
}

export function parseHttpProxyConfig(
  env: Record<string, string | undefined> = process.env,
): HttpProxyConfig {
  return normalizeHttpProxyConfig({
    baseUrl: env.ORACLE_HTTP_BASE_URL,
    timeoutMs: env.ORACLE_HTTP_TIMEOUT_MS,
  });
}
function normalizedText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function collectPayloadStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === 'string') {
    const normalized = normalizedText(value);
    if (normalized) output.push(normalized);
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    output.push(String(value));
  } else if (Array.isArray(value)) {
    for (const item of value) collectPayloadStrings(item, output);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectPayloadStrings(item, output);
  }
  return output;
}
async function safeErrorDetail(response: Response, payload: unknown): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_ERROR_BODY_BYTES + 1);
  let used = 0;
  try {
    while (used <= MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const copied = Math.min(value.length, bytes.length - used);
      bytes.set(value.subarray(0, copied), used);
      used += copied;
      if (used > MAX_ERROR_BODY_BYTES) break;
    }
  } finally {
    if (used > MAX_ERROR_BODY_BYTES) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (used > MAX_ERROR_BODY_BYTES) return 'upstream error detail omitted (body too large)';
  let detail = normalizedText(new TextDecoder().decode(bytes.subarray(0, used)));
  for (const secret of collectPayloadStrings(payload).sort((a, b) => b.length - a.length)) {
    detail = detail.replaceAll(secret, '[redacted]');
  }
  return detail;
}

function errorResponse(message: string): ToolResponse {
  return { content: [{ type: 'text', text: message }], isError: true };
}
const verifyLearning = 'outcome may be unknown. Verify the deterministic learning ID/file before retrying an identical request.';

export function createHttpProxyClient(
  inputConfig: HttpProxyConfig = parseHttpProxyConfig(),
  fetchImpl: typeof fetch = globalThis.fetch,
) {
  const config = normalizeHttpProxyConfig(inputConfig);
  let healthChecked = false;

  async function fetchJson(path: string, body: unknown, payload?: unknown): Promise<unknown> {
    const serializedBody = JSON.stringify(body);
    const startedAt = performance.now();
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.timeoutMs);
    try {
      const response = await fetchImpl(`${config.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: serializedBody,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ProxyHttpError(response.status, await safeErrorDetail(response, payload));
      }
      const text = await response.text();
      return text ? JSON.parse(text) : {};
    } catch (error) {
      if (timedOut) {
        throw new ProxyTimeoutError(Math.max(0, Math.round(performance.now() - startedAt)));
      }
      if (error instanceof ProxyHttpError || error instanceof SyntaxError) throw error;
      throw new ProxyNetworkError();
    } finally {
      clearTimeout(timeout);
    }
  }

  async function ensureHealthy(): Promise<boolean> {
    if (healthChecked) return true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetchImpl(`${config.baseUrl}/api/health`, { signal: controller.signal });
      if (!response.ok) return false;
      const health = await response.json() as { status?: string };
      healthChecked = health.status === 'ok';
      return healthChecked;
    } catch {
      healthChecked = false;
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function listTools(): Promise<unknown> {
    if (!await ensureHealthy()) return { tools: [] };
    try {
      return await fetchJson('/mcp/tools', {});
    } catch (error) {
      healthChecked = false;
      throw error;
    }
  }

  async function callTool(name: string, args: unknown = {}): Promise<ToolResponse> {
    if (!await ensureHealthy()) {
      return errorResponse('Oracle HTTP endpoint is unavailable or unhealthy; check the configured endpoint and service health.');
    }
    try {
      return await fetchJson('/mcp/call', { name, arguments: args, repoRoot: '' }, args) as ToolResponse;
    } catch (error) {
      healthChecked = false;
      if (error instanceof ProxyTimeoutError) {
        const base = `Error: Tool "${name}" timed out after ${error.elapsedMs} ms.`;
        return errorResponse(name === 'arra_learn' ? `${base} ${verifyLearning}` : `${base} Check the Oracle endpoint before retrying.`);
      }
      if (error instanceof ProxyHttpError) {
        const base = `Error: Tool "${name}" ${error.message}`;
        return errorResponse(name === 'arra_learn' && error.status >= 500 ? `${base}; ${verifyLearning}` : base);
      }
      if (error instanceof ProxyNetworkError) {
        const base = `Error: Tool "${name}" network request failed after dispatch.`;
        return errorResponse(name === 'arra_learn' ? `${base} ${verifyLearning}` : `${base} Check the Oracle endpoint before retrying.`);
      }
      return errorResponse(`Error: Tool "${name}" returned an invalid response.`);
    }
  }

  return { callTool, ensureHealthy, listTools };
}
export function createHttpProxyServer(client = createHttpProxyClient()): Server {
  const server = new Server(
    { name: 'arra-oracle-v2-http-proxy', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const response = await client.listTools() as { tools?: unknown };
    return { tools: Array.isArray(response.tools) ? response.tools : [] };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => (
    client.callTool(request.params.name, request.params.arguments ?? {})
  ));
  return server;
}

async function main() {
  await createHttpProxyServer().connect(new StdioServerTransport());
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
