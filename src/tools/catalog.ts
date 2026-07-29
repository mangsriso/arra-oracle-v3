import {
  searchToolDef,
  readToolDef,
  learnToolDef,
  listToolDef,
  statsToolDef,
  conceptsToolDef,
  supersedeToolDef,
  handoffToolDef,
  inboxToolDef,
  forumToolDefs,
  traceToolDefs,
  reflectToolDef,
  verifyToolDef,
  scheduleAddToolDef,
  scheduleListToolDef,
} from './index.ts';

export const MCP_TOOL_NAMES = [
  '____IMPORTANT',
  'arra_search',
  'arra_read',
  'arra_learn',
  'arra_list',
  'arra_stats',
  'arra_concepts',
  'arra_thread',
  'arra_threads',
  'arra_thread_read',
  'arra_thread_update',
  'arra_trace',
  'arra_trace_list',
  'arra_trace_get',
  'arra_trace_link',
  'arra_trace_unlink',
  'arra_trace_chain',
  'arra_supersede',
  'arra_handoff',
  'arra_inbox',
  'arra_reflect',
  'arra_verify',
  'arra_schedule_add',
  'arra_schedule_list',
] as const;

export type McpToolName = typeof MCP_TOOL_NAMES[number];

export function buildImportantTool(version: string) {
  return {
    name: '____IMPORTANT',
    description: `ORACLE WORKFLOW GUIDE (v${version}):\n\n1. SEARCH & DISCOVER\n   arra_search(query) → Find knowledge by keywords/vectors\n   arra_read(file/id) → Read full document content\n   arra_list() → Browse all documents\n   arra_concepts() → See topic coverage\n\n2. LEARN & REMEMBER\n   arra_learn(pattern) → Add new patterns/learnings\n   arra_thread(message) → Multi-turn discussions\n   ⚠️ BEFORE adding: search for similar topics first!\n   If updating old info → use arra_supersede(oldId, newId)\n\n3. TRACE & DISTILL\n   arra_trace(query) → Log discovery sessions with dig points\n   arra_trace_list() → Find past traces\n   arra_trace_get(id) → Explore dig points (files, commits, issues)\n   arra_trace_link(prevId, nextId) → Chain related traces together\n   arra_trace_chain(id) → View the full linked chain\n\n4. HANDOFF & INBOX\n   arra_handoff(content) → Save session context for next session\n   arra_inbox() → List pending handoffs\n\n5. SUPERSEDE (when info changes)\n   arra_supersede(oldId, newId, reason) → Mark old doc as outdated\n   "Nothing is Deleted" — old preserved, just marked superseded\n\nPhilosophy: "Nothing is Deleted" — All interactions logged.`,
    inputSchema: { type: 'object', properties: {} },
  };
}

export function buildMcpToolCatalog(version: string) {
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
    reflectToolDef,
    verifyToolDef,
    scheduleAddToolDef,
    scheduleListToolDef,
  ];
}
