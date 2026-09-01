import type { ToolResponse } from '../tools/types.ts';
import type { LearnPersistenceResult } from './persistence.ts';

export function mcpLearnResponse(
  result: LearnPersistenceResult,
  extra: Record<string, unknown> = {},
): ToolResponse {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ ...result, ...extra }, null, 2),
    }],
    ...(result.success ? {} : { isError: true }),
  };
}

export function httpStatusForLearn(result: LearnPersistenceResult): number {
  if (result.outcome === 'created') return 201;
  if (result.outcome === 'partial') return 503;
  if (result.outcome === 'degraded') return 409;
  return 200;
}
