import type { McpToolName } from './catalog.ts';

export type ToolCapability = 'read' | 'write' | 'conditional-write' | 'telemetry-write';

export const MCP_TOOL_CAPABILITIES = {
  ____IMPORTANT: 'read',
  arra_search: 'telemetry-write',
  arra_read: 'read',
  arra_learn: 'write',
  arra_list: 'read',
  arra_stats: 'read',
  arra_concepts: 'read',
  arra_thread: 'write',
  arra_threads: 'read',
  arra_thread_read: 'read',
  arra_thread_update: 'write',
  arra_trace: 'write',
  arra_trace_list: 'read',
  arra_trace_get: 'read',
  arra_trace_link: 'write',
  arra_trace_unlink: 'write',
  arra_trace_chain: 'read',
  arra_supersede: 'write',
  arra_handoff: 'write',
  arra_inbox: 'read',
  arra_reflect: 'read',
  arra_verify: 'conditional-write',
  arra_schedule_add: 'write',
  arra_schedule_list: 'read',
} as const satisfies Record<McpToolName, ToolCapability>;

export interface ToolCallDecision {
  allowed: boolean;
  telemetryEnabled: boolean;
  error?: string;
}

export function getToolCapability(name: string): ToolCapability | null {
  if (!Object.prototype.hasOwnProperty.call(MCP_TOOL_CAPABILITIES, name)) return null;
  return MCP_TOOL_CAPABILITIES[name as McpToolName];
}

export function filterToolCatalog<T extends { name: string }>(
  tools: T[],
  readOnly: boolean,
): T[] {
  return tools.filter((tool) => {
    const capability = getToolCapability(tool.name);
    if (!capability) return false;
    return !readOnly || capability !== 'write';
  });
}

export function decideToolCall(
  name: string,
  args: unknown,
  readOnly: boolean,
): ToolCallDecision {
  const capability = getToolCapability(name);
  if (!capability) {
    return {
      allowed: false,
      telemetryEnabled: false,
      error: `Tool "${name}" has no write-capability classification.`,
    };
  }

  if (!readOnly) return { allowed: true, telemetryEnabled: true };

  if (capability === 'write') {
    return {
      allowed: false,
      telemetryEnabled: false,
      error: `Tool "${name}" is disabled in read-only mode.`,
    };
  }

  if (
    capability === 'conditional-write'
    && typeof args === 'object'
    && args !== null
    && (args as Record<string, unknown>).check === false
  ) {
    return {
      allowed: false,
      telemetryEnabled: false,
      error: `Tool "${name}" with check=false is disabled in read-only mode.`,
    };
  }

  return {
    allowed: true,
    telemetryEnabled: capability !== 'telemetry-write',
  };
}
