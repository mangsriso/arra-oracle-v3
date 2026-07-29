import type { ToolContext, ToolResponse } from './types.ts';
import {
  handleSearch,
  handleRead,
  handleLearn,
  handleList,
  handleStats,
  handleConcepts,
  handleSupersede,
  handleHandoff,
  handleInbox,
  handleThread,
  handleThreads,
  handleThreadRead,
  handleThreadUpdate,
  handleTrace,
  handleTraceList,
  handleTraceGet,
  handleTraceLink,
  handleTraceUnlink,
  handleTraceChain,
  handleReflect,
  handleVerify,
  handleScheduleAdd,
  handleScheduleList,
  type OracleSearchInput,
  type OracleReadInput,
  type OracleLearnInput,
  type OracleListInput,
  type OracleStatsInput,
  type OracleConceptsInput,
  type OracleSupersededInput,
  type OracleHandoffInput,
  type OracleInboxInput,
  type OracleThreadInput,
  type OracleThreadsInput,
  type OracleThreadReadInput,
  type OracleThreadUpdateInput,
  type OracleReflectInput,
  type OracleVerifyInput,
  type OracleScheduleAddInput,
  type OracleScheduleListInput,
  type CreateTraceInput,
  type ListTracesInput,
  type GetTraceInput,
} from './index.ts';
import { buildImportantTool } from './catalog.ts';

export async function dispatchMcpTool(
  name: string,
  args: unknown,
  ctx: ToolContext,
  version: string,
): Promise<ToolResponse> {
  switch (name) {
    case '____IMPORTANT':
      return { content: [{ type: 'text', text: buildImportantTool(version).description }] };
    case 'arra_search': return handleSearch(ctx, args as OracleSearchInput);
    case 'arra_read': return handleRead(ctx, args as OracleReadInput);
    case 'arra_learn': return handleLearn(ctx, args as OracleLearnInput);
    case 'arra_list': return handleList(ctx, args as OracleListInput);
    case 'arra_stats': return handleStats(ctx, args as OracleStatsInput);
    case 'arra_concepts': return handleConcepts(ctx, args as OracleConceptsInput);
    case 'arra_supersede': return handleSupersede(ctx, args as OracleSupersededInput);
    case 'arra_handoff': return handleHandoff(ctx, args as OracleHandoffInput);
    case 'arra_inbox': return handleInbox(ctx, args as OracleInboxInput);
    case 'arra_thread': return handleThread(args as OracleThreadInput);
    case 'arra_threads': return handleThreads(args as OracleThreadsInput);
    case 'arra_thread_read': return handleThreadRead(args as OracleThreadReadInput);
    case 'arra_thread_update': return handleThreadUpdate(args as OracleThreadUpdateInput);
    case 'arra_trace': return handleTrace(args as CreateTraceInput);
    case 'arra_trace_list': return handleTraceList(args as ListTracesInput);
    case 'arra_trace_get': return handleTraceGet(args as GetTraceInput);
    case 'arra_trace_link':
      return handleTraceLink(args as { prevTraceId: string; nextTraceId: string });
    case 'arra_trace_unlink':
      return handleTraceUnlink(args as { traceId: string; direction: 'prev' | 'next' });
    case 'arra_trace_chain': return handleTraceChain(args as { traceId: string });
    case 'arra_reflect': return handleReflect(ctx, args as OracleReflectInput);
    case 'arra_verify': return handleVerify(ctx, args as OracleVerifyInput);
    case 'arra_schedule_add': return handleScheduleAdd(ctx, args as OracleScheduleAddInput);
    case 'arra_schedule_list': return handleScheduleList(ctx, args as OracleScheduleListInput);
    default:
      return {
        content: [{ type: 'text', text: `Error: Unknown tool: ${name}` }],
        isError: true,
      };
  }
}
