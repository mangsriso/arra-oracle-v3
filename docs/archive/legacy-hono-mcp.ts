/**
 * Archived 2026-07-29 before removing the dead Hono MCP route module.
 *
 * Evidence: src/server.ts mounts the Elysia implementation from
 * src/routes/mcp/index.ts; no production import mounted this Hono registrar.
 * The original source is preserved verbatim below for Nothing Deleted.
 */
import type { Hono } from 'hono';
import { getDisabledTools, loadToolGroupConfig } from '../config/tool-groups.ts';
import { buildMcpToolCatalog } from '../tools/catalog.ts';
import { dispatchMcpTool } from '../tools/dispatch.ts';
import { decideToolCall, filterToolCatalog } from '../tools/write-policy.ts';
import type {
  ToolContext,
  ToolResponse,
} from '../tools/index.ts';

interface McpListToolsRequest {
  repoRoot?: string;
}

interface McpCallRequest {
  name?: string;
  arguments?: unknown;
  repoRoot?: string;
}

function getDisabledToolSet(repoRoot?: string): Set<string> {
  return getDisabledTools(loadToolGroupConfig(repoRoot));
}

function errorResponse(message: string): ToolResponse {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

function getRepoRoot(override: unknown, fallback: string): string {
  return typeof override === 'string' && override.length > 0 ? override : fallback;
}

export function registerMcpRoutes(app: Hono, ctx: ToolContext) {
  app.post('/mcp/tools', async (c) => {
    const body = await c.req.json().catch(() => ({})) as McpListToolsRequest;
    const repoRoot = getRepoRoot(body.repoRoot, ctx.repoRoot);
    const disabledTools = getDisabledToolSet(repoRoot);
    const configuredTools = buildMcpToolCatalog(ctx.version)
      .filter((tool) => !disabledTools.has(tool.name));
    const readOnly = process.env.ORACLE_READ_ONLY === 'true';
    const tools = filterToolCatalog(configuredTools, readOnly);

    return c.json({ tools });
  });

  app.post('/mcp/call', async (c) => {
    const body = await c.req.json().catch(() => null) as McpCallRequest | null;
    if (!body || typeof body.name !== 'string' || body.name.length === 0) {
      return c.json(errorResponse('Missing tool name'));
    }

    const repoRoot = getRepoRoot(body.repoRoot, ctx.repoRoot);
    const disabledTools = getDisabledToolSet(repoRoot);
    if (disabledTools.has(body.name)) {
      return c.json(errorResponse(`Tool \"${body.name}\" is disabled by tool group config.`));
    }

    const readOnly = process.env.ORACLE_READ_ONLY === 'true';
    const decision = decideToolCall(body.name, body.arguments, readOnly);
    if (!decision.allowed) return c.json(errorResponse(decision.error!));
    const baseCtx = repoRoot === ctx.repoRoot ? ctx : { ...ctx, repoRoot };
    const callCtx = { ...baseCtx, telemetryEnabled: decision.telemetryEnabled };

    try {
      return c.json(await dispatchMcpTool(body.name, body.arguments, callCtx, ctx.version));
    } catch (error) {
      return c.json(errorResponse(error instanceof Error ? error.message : String(error)));
    }
  });
}
