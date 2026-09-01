import { getEmbeddingModels } from '../vector/factory.ts';
import { resolveAsyncIndexerConfig } from '../vector/indexer-config.ts';
import { LearnConflictError, persistAsyncLearning } from '../learn/persistence.ts';
import { mcpLearnResponse } from '../learn/transport.ts';
import {
  extractProjectFromSource, normalizeProject, resolveLearnProject,
} from '../learn/project.ts';
import { resolveLearnStorage } from '../learn/storage.ts';
import { handleLegacyLearn } from './learn-legacy.ts';
import type { ToolContext, ToolResponse, OracleLearnInput } from './types.ts';

export function coerceConcepts(concepts: unknown): string[] {
  if (Array.isArray(concepts)) return concepts.map(String);
  if (typeof concepts === 'string') {
    return concepts.split(',').map((value) => value.trim()).filter(Boolean);
  }
  return [];
}

export const learnToolDef = {
  name: 'arra_learn',
  description: 'Add a new pattern or learning to the Oracle knowledge base. Creates a markdown file in ψ/memory/learnings/ and indexes it.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string', minLength: 1,
        description: 'The pattern or learning to add (can be multi-line). Must be non-empty and not whitespace-only.',
      },
      source: { type: 'string', description: 'Optional source attribution (defaults to "Oracle Learn")' },
      concepts: {
        type: 'array', items: { type: 'string' },
        description: 'Optional concept tags (e.g., ["git", "safety", "trust"])',
      },
      project: {
        type: 'string',
        description: 'Source project. Accepts github.com/owner/repo, owner/repo, a GitHub URL, or ghq path.',
      },
      idempotency_key: {
        type: 'string',
        description: 'Optional retry key. Reuse is allowed only for identical canonical content.',
      },
    },
    required: ['pattern'],
  },
};

export { extractProjectFromSource, normalizeProject };

export async function handleLearn(ctx: ToolContext, input: OracleLearnInput): Promise<ToolResponse> {
  if (typeof input?.pattern !== 'string' || input.pattern.trim() === '') {
    return {
      content: [{
        type: 'text',
        text: `Error: arra_learn requires a non-empty string "pattern". Received keys: [${Object.keys(input ?? {}).join(', ')}]. The learning text goes in "pattern"; tags go in "concepts".`,
      }],
      isError: true,
    };
  }
  const models = getEmbeddingModels();
  let runtime;
  try {
    runtime = resolveAsyncIndexerConfig(models);
  } catch (error) {
    return errorResponse(error);
  }
  let project: string | null;
  try {
    project = resolveLearnProject({ project: input.project, source: input.source, cwd: ctx.repoRoot });
  } catch (error) {
    return errorResponse(error);
  }
  if (!runtime.producerEnabled) {
    if (process.env.ORACLE_LEARN_LEGACY_MODE !== '1') {
      return errorResponse(new Error(
        'arra_learn persistence is disabled; enable the async producer or explicitly set ORACLE_LEARN_LEGACY_MODE=1',
      ));
    }
    return handleLegacyLearn(ctx, input, project, resolveLearnStorage(project));
  }

  const storage = resolveLearnStorage(project);
  try {
    const result = await persistAsyncLearning({
      sqlite: ctx.sqlite, learningDir: storage.learningDir,
      sourceFilePrefix: storage.sourceFilePrefix, models,
    }, {
      pattern: input.pattern, concepts: input.concepts, source: input.source,
      project, origin: null, idempotencyKey: input.idempotency_key,
    });
    return mcpLearnResponse(result, storage.warning ? { warning: storage.warning } : {});
  } catch (error) {
    return errorResponse(error, error instanceof LearnConflictError ? 'conflict' : 'error');
  }
}

function errorResponse(error: unknown, outcome = 'error'): ToolResponse {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        success: false, outcome,
        error: error instanceof Error ? error.message : String(error),
      }, null, 2),
    }],
    isError: true,
  };
}
