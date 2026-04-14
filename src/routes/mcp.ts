import type { Hono } from 'hono';
import { getDisabledTools, loadToolGroupConfig } from '../config/tool-groups.ts';
import type {
  ToolContext,
  ToolResponse,
  OracleSearchInput,
  OracleReadInput,
  OracleLearnInput,
  OracleListInput,
  OracleStatsInput,
  OracleConceptsInput,
  OracleSupersededInput,
  OracleHandoffInput,
  OracleInboxInput,
  OracleThreadInput,
  OracleThreadsInput,
  OracleThreadReadInput,
  OracleThreadUpdateInput,
  CreateTraceInput,
  ListTracesInput,
  GetTraceInput,
} from '../tools/index.ts';
import {
  searchToolDef,
  handleSearch,
  readToolDef,
  handleRead,
  learnToolDef,
  handleLearn,
  listToolDef,
  handleList,
  statsToolDef,
  handleStats,
  conceptsToolDef,
  handleConcepts,
  supersedeToolDef,
  handleSupersede,
  handoffToolDef,
  handleHandoff,
  inboxToolDef,
  handleInbox,
  forumToolDefs,
  handleThread,
  handleThreads,
  handleThreadRead,
  handleThreadUpdate,
  traceToolDefs,
  handleTrace,
  handleTraceList,
  handleTraceGet,
  handleTraceLink,
  handleTraceUnlink,
  handleTraceChain,
} from '../tools/index.ts';

interface McpListToolsRequest {
  repoRoot?: string;
}

interface McpCallRequest {
  name?: string;
  arguments?: unknown;
  repoRoot?: string;
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
    searchToolDef,
    readToolDef,
    learnToolDef,
    listToolDef,
    statsToolDef,
    conceptsToolDef,
    ...forumToolDefs,
    ...traceToolDefs,
    supersedeToolDef,
    handoffToolDef,
    inboxToolDef,
  ];
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

const WRITE_TOOLS = [
  'arra_learn',
  'arra_thread',
  'arra_thread_update',
  'arra_trace',
  'arra_supersede',
  'arra_handoff',
];

function getRepoRoot(override: unknown, fallback: string): string {
  return typeof override === 'string' && override.length > 0 ? override : fallback;
}

export function registerMcpRoutes(app: Hono, ctx: ToolContext) {
  app.post('/mcp/tools', async (c) => {
    const body = await c.req.json().catch(() => ({})) as McpListToolsRequest;
    const repoRoot = getRepoRoot(body.repoRoot, ctx.repoRoot);
    const disabledTools = getDisabledToolSet(repoRoot);
    let tools = buildToolList(ctx.version).filter((tool) => !disabledTools.has(tool.name));
    const readOnly = process.env.ORACLE_READ_ONLY === 'true';
    if (readOnly) {
      tools = tools.filter(t => !WRITE_TOOLS.includes(t.name));
    }

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
    if (readOnly && WRITE_TOOLS.includes(body.name)) {
      return c.json(errorResponse(`Tool \"${body.name}\" is disabled in read-only mode. This Oracle instance is configured for read-only access.`));
    }

    const callCtx = repoRoot === ctx.repoRoot ? ctx : { ...ctx, repoRoot };

    try {
      switch (body.name) {
        case 'arra_search':
          return c.json(await handleSearch(callCtx, body.arguments as OracleSearchInput));
        case 'arra_read':
          return c.json(await handleRead(callCtx, body.arguments as OracleReadInput));
        case 'arra_learn':
          return c.json(await handleLearn(callCtx, body.arguments as OracleLearnInput));
        case 'arra_list':
          return c.json(await handleList(callCtx, body.arguments as OracleListInput));
        case 'arra_stats':
          return c.json(await handleStats(callCtx, body.arguments as OracleStatsInput));
        case 'arra_concepts':
          return c.json(await handleConcepts(callCtx, body.arguments as OracleConceptsInput));
        case 'arra_supersede':
          return c.json(await handleSupersede(callCtx, body.arguments as OracleSupersededInput));
        case 'arra_handoff':
          return c.json(await handleHandoff(callCtx, body.arguments as OracleHandoffInput));
        case 'arra_inbox':
          return c.json(await handleInbox(callCtx, body.arguments as OracleInboxInput));
        case 'arra_thread':
          return c.json(await handleThread(body.arguments as OracleThreadInput));
        case 'arra_threads':
          return c.json(await handleThreads(body.arguments as OracleThreadsInput));
        case 'arra_thread_read':
          return c.json(await handleThreadRead(body.arguments as OracleThreadReadInput));
        case 'arra_thread_update':
          return c.json(await handleThreadUpdate(body.arguments as OracleThreadUpdateInput));
        case 'arra_trace':
          return c.json(await handleTrace(body.arguments as CreateTraceInput));
        case 'arra_trace_list':
          return c.json(await handleTraceList(body.arguments as ListTracesInput));
        case 'arra_trace_get':
          return c.json(await handleTraceGet(body.arguments as GetTraceInput));
        case 'arra_trace_link':
          return c.json(await handleTraceLink(body.arguments as { prevTraceId: string; nextTraceId: string }));
        case 'arra_trace_unlink':
          return c.json(await handleTraceUnlink(body.arguments as { traceId: string; direction: 'prev' | 'next' }));
        case 'arra_trace_chain':
          return c.json(await handleTraceChain(body.arguments as { traceId: string }));
        default:
          return c.json(errorResponse(`Unknown tool: ${body.name}`));
      }
    } catch (error) {
      return c.json(errorResponse(error instanceof Error ? error.message : String(error)));
    }
  });
}
