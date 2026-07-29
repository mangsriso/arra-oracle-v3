/**
 * MCP Routes (Elysia) — restores POST /mcp/tools + POST /mcp/call.
 *
 * Ports the dispatcher logic from the archived Hono implementation in
 * docs/archive/legacy-hono-mcp.ts. Uses the same tool handlers + ToolContext.
 *
 * Ref: ψ/memory/learnings/2026-05-15_oracle-mcp-proxy-v2-v3-path-mismatch.md
 * Plan: ψ/inbox/plans/2026-05-15_2245_oracle-mcp-port-mcp-routes-elysia.md
 * (passed R1+R2+R3 dual adversarial review)
 */

import { Elysia } from 'elysia';
import { db, sqlite } from '../../db/index.ts';
import { ensureVectorStoreConnected } from '../../vector/factory.ts';
import type { VectorStoreAdapter } from '../../vector/types.ts';
import { REPO_ROOT } from '../../config.ts';
import { getDisabledTools, loadToolGroupConfig } from '../../config/tool-groups.ts';
import pkg from '../../../package.json' with { type: 'json' };
import type { ToolContext, ToolResponse } from '../../tools/types.ts';
import { buildMcpToolCatalog } from '../../tools/catalog.ts';
import { dispatchMcpTool } from '../../tools/dispatch.ts';
import { decideToolCall, filterToolCatalog } from '../../tools/write-policy.ts';

function errorResponse(message: string): ToolResponse {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

function getRepoRoot(override: unknown, fallback: string): string {
  return typeof override === 'string' && override.length > 0 ? override : fallback;
}

// EXEC-fix: use SHARED singleton via ensureVectorStoreConnected() to avoid
// double-opening LanceDB at the same data dir (crashed Bun in initial run
// at 16:24 — was created as independent createVectorStore which conflicted
// with handlers.ts's lazy-init singleton on same lancedb path).
let vectorStore: VectorStoreAdapter | undefined;
let vectorStatus: 'unknown' | 'connected' | 'empty' | 'unavailable' = 'unknown';

// vectorReady: resolve the canonical shared singleton. /mcp/call handlers
// await this before tool work; /mcp/tools does NOT await (R3-fix).
export const vectorReady = (async () => {
  try {
    vectorStore = await ensureVectorStoreConnected('bge-m3');
    vectorStatus = 'connected';
    console.error(`[VectorDB:${vectorStore.name}] ✓ Connected (mcpRoutes shared singleton)`);
  } catch (e) {
    vectorStatus = 'unavailable';
    console.error(`[VectorDB] ✗ Cannot connect:`, e instanceof Error ? e.message : String(e));
  }
})();

// Build ctx inline (no spread on getter — R2-C1 fix). Both vectorStore and
// vectorStatus use live getters so defaultCtx built at module load (before
// vectorReady resolves) updates automatically once singleton resolves.
function buildCtx(repoRoot: string): ToolContext {
  return {
    db, sqlite, repoRoot,
    get vectorStore() { return vectorStore as VectorStoreAdapter; },
    get vectorStatus() { return vectorStatus; },
    version: pkg.version,
  };
}

const defaultCtx: ToolContext = buildCtx(REPO_ROOT);

function resolveCtx(repoRoot: string): ToolContext {
  return repoRoot === REPO_ROOT ? defaultCtx : buildCtx(repoRoot);
}

export const mcpRoutes = new Elysia()
  // Local .onError as backstop for PARSE/unexpected (handler bodies wrap in
  // try/catch so escapes are rare). NOT_FOUND falls through to parent 404.
  .onError(({ code, error, set }) => {
    if (code === 'NOT_FOUND') return;
    set.status = 200;
    return errorResponse(error instanceof Error ? error.message : String(error));
  })
  // CrossCheck-fix: Elysia parent app auto-parses JSON body and emits PARSE
  // error at parent level BEFORE sub-app .onError fires. To guarantee MCP-shape
  // on ALL inputs (including malformed JSON), we bypass auto-parse via
  // `body: t.Unknown()` + raw `request.text()` + manual JSON.parse in try/catch.
  .post('/mcp/tools', async ({ request }) => {
    // R3-fix: metadata-only endpoint — do NOT await vectorReady (parity).
    try {
      const raw = await request.text();
      let req: { repoRoot?: string } = {};
      if (raw && raw.trim()) {
        try { req = JSON.parse(raw); }
        catch { return errorResponse('Invalid JSON body'); }
      }
      const repoRoot = getRepoRoot(req.repoRoot, REPO_ROOT);
      const disabledTools = getDisabledTools(loadToolGroupConfig(repoRoot));
      const configuredTools = buildMcpToolCatalog(pkg.version)
        .filter((tool) => !disabledTools.has(tool.name));
      const tools = filterToolCatalog(
        configuredTools,
        process.env.ORACLE_READ_ONLY === 'true',
      );
      return { tools };
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : String(error));
    }
  }, { parse: 'none' })
  .post('/mcp/call', async ({ request }) => {
    try {
      await vectorReady;
      const raw = await request.text();
      let req: { name?: string; arguments?: unknown; repoRoot?: string } = {};
      if (raw && raw.trim()) {
        try { req = JSON.parse(raw); }
        catch { return errorResponse('Invalid JSON body'); }
      }
      if (!req.name || typeof req.name !== 'string') {
        return errorResponse('Missing tool name');
      }
      const repoRoot = getRepoRoot(req.repoRoot, REPO_ROOT);
      const disabledTools = getDisabledTools(loadToolGroupConfig(repoRoot));
      if (disabledTools.has(req.name)) {
        return errorResponse(`Tool "${req.name}" is disabled by tool group config.`);
      }
      const args = req.arguments;
      const decision = decideToolCall(
        req.name,
        args,
        process.env.ORACLE_READ_ONLY === 'true',
      );
      if (!decision.allowed) return errorResponse(decision.error!);
      const ctx = {
        ...resolveCtx(repoRoot),
        telemetryEnabled: decision.telemetryEnabled,
      };
      return await dispatchMcpTool(req.name, args, ctx, pkg.version);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : String(error));
    }
  }, { parse: 'none' });
