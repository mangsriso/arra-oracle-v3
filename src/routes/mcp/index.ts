/**
 * MCP Routes (Elysia) — restores POST /mcp/tools + POST /mcp/call.
 *
 * Ports the dispatcher logic from legacy src/routes/mcp.ts (Hono) which
 * was orphaned during the v2→v3 framework split. Uses the same tool
 * handlers + ToolContext, so behavior is byte-identical to pre-v3.
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
import {
  // ToolDef exports
  searchToolDef, readToolDef, learnToolDef, listToolDef, statsToolDef,
  conceptsToolDef, supersedeToolDef, handoffToolDef, inboxToolDef,
  forumToolDefs, traceToolDefs, reflectToolDef, verifyToolDef,
  scheduleAddToolDef, scheduleListToolDef,
  // Handler exports
  handleSearch, handleRead, handleLearn, handleList, handleStats,
  handleConcepts, handleSupersede, handleHandoff, handleInbox,
  handleThread, handleThreads, handleThreadRead, handleThreadUpdate,
  handleTrace, handleTraceList, handleTraceGet, handleTraceLink,
  handleTraceUnlink, handleTraceChain, handleReflect, handleVerify,
  handleScheduleAdd, handleScheduleList,
} from '../../tools/index.ts';
import type {
  OracleSearchInput, OracleReadInput, OracleLearnInput, OracleListInput,
  OracleStatsInput, OracleConceptsInput, OracleSupersededInput,
  OracleHandoffInput, OracleInboxInput, OracleThreadInput, OracleThreadsInput,
  OracleThreadReadInput, OracleThreadUpdateInput, OracleReflectInput,
  OracleVerifyInput, OracleScheduleAddInput, OracleScheduleListInput,
  CreateTraceInput, ListTracesInput, GetTraceInput,
} from '../../tools/index.ts';

const WRITE_TOOLS = [
  'arra_learn', 'arra_thread', 'arra_thread_update', 'arra_trace',
  'arra_supersede', 'arra_handoff', 'arra_schedule_add',
];

function errorResponse(message: string): ToolResponse {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

function buildImportantTool(version: string) {
  return {
    name: '____IMPORTANT',
    description: `ORACLE WORKFLOW GUIDE (v${version}):\n\n1. SEARCH & DISCOVER\n   arra_search(query) → Find knowledge by keywords/vectors\n   arra_read(file/id) → Read full document content\n   arra_list() → Browse all documents\n   arra_concepts() → See topic coverage\n\n2. LEARN & REMEMBER\n   arra_learn(pattern) → Add new patterns/learnings\n   arra_thread(message) → Multi-turn discussions\n   ⚠️ BEFORE adding: search for similar topics first!\n   If updating old info → use arra_supersede(oldId, newId)\n\n3. TRACE & DISTILL\n   arra_trace(query) → Log discovery sessions with dig points\n   arra_trace_list() → Find past traces\n   arra_trace_get(id) → Explore dig points (files, commits, issues)\n   arra_trace_link(prevId, nextId) → Chain related traces together\n   arra_trace_chain(id) → View the full linked chain\n\n4. HANDOFF & INBOX\n   arra_handoff(content) → Save session context for next session\n   arra_inbox() → List pending handoffs\n\n5. SUPERSEDE (when info changes)\n   arra_supersede(oldId, newId, reason) → Mark old doc as outdated\n   "Nothing is Deleted" — old preserved, just marked superseded\n\nPhilosophy: "Nothing is Deleted" — All interactions logged.`,
    inputSchema: { type: 'object', properties: {} },
  };
}

function buildToolList(version: string) {
  return [
    buildImportantTool(version),
    searchToolDef, readToolDef, learnToolDef, listToolDef, statsToolDef,
    conceptsToolDef, ...forumToolDefs, ...traceToolDefs, supersedeToolDef,
    handoffToolDef, inboxToolDef, reflectToolDef, verifyToolDef,
    scheduleAddToolDef, scheduleListToolDef,
  ];
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
      let tools = buildToolList(pkg.version).filter((t) => !disabledTools.has(t.name));
      if (process.env.ORACLE_READ_ONLY === 'true') {
        tools = tools.filter((t) => !WRITE_TOOLS.includes(t.name));
      }
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
      if (process.env.ORACLE_READ_ONLY === 'true' && WRITE_TOOLS.includes(req.name)) {
        return errorResponse(`Tool "${req.name}" is disabled in read-only mode.`);
      }
      const ctx = resolveCtx(repoRoot);
      const args = req.arguments;
      switch (req.name) {
        case '____IMPORTANT':
          return { content: [{ type: 'text', text: buildImportantTool(pkg.version).description }] };
        case 'arra_search':       return await handleSearch(ctx, args as OracleSearchInput);
        case 'arra_read':         return await handleRead(ctx, args as OracleReadInput);
        case 'arra_learn':        return await handleLearn(ctx, args as OracleLearnInput);
        case 'arra_list':         return await handleList(ctx, args as OracleListInput);
        case 'arra_stats':        return await handleStats(ctx, args as OracleStatsInput);
        case 'arra_concepts':     return await handleConcepts(ctx, args as OracleConceptsInput);
        case 'arra_supersede':    return await handleSupersede(ctx, args as OracleSupersededInput);
        case 'arra_handoff':      return await handleHandoff(ctx, args as OracleHandoffInput);
        case 'arra_inbox':        return await handleInbox(ctx, args as OracleInboxInput);
        case 'arra_thread':       return await handleThread(args as OracleThreadInput);
        case 'arra_threads':      return await handleThreads(args as OracleThreadsInput);
        case 'arra_thread_read':  return await handleThreadRead(args as OracleThreadReadInput);
        case 'arra_thread_update':return await handleThreadUpdate(args as OracleThreadUpdateInput);
        case 'arra_trace':        return await handleTrace(args as CreateTraceInput);
        case 'arra_trace_list':   return await handleTraceList(args as ListTracesInput);
        case 'arra_trace_get':    return await handleTraceGet(args as GetTraceInput);
        case 'arra_trace_link':   return await handleTraceLink(args as { prevTraceId: string; nextTraceId: string });
        case 'arra_trace_unlink': return await handleTraceUnlink(args as { traceId: string; direction: 'prev' | 'next' });
        case 'arra_trace_chain':  return await handleTraceChain(args as { traceId: string });
        case 'arra_reflect':      return await handleReflect(ctx, args as OracleReflectInput);
        case 'arra_verify':       return await handleVerify(ctx, args as OracleVerifyInput);
        case 'arra_schedule_add': return await handleScheduleAdd(ctx, args as OracleScheduleAddInput);
        case 'arra_schedule_list':return await handleScheduleList(ctx, args as OracleScheduleListInput);
        default:                  return errorResponse(`Unknown tool: ${req.name}`);
      }
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : String(error));
    }
  }, { parse: 'none' });
