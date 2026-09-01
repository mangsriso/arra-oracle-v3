/**
 * POST /api/learn — record a learning pattern.
 */

import { Elysia } from 'elysia';
import { handleLearn } from '../../server/handlers.ts';
import { LearnBody } from './model.ts';
import { LearnConflictError } from '../../learn/persistence.ts';
import { httpStatusForLearn } from '../../learn/transport.ts';

export const learnEndpoint = new Elysia()
  .onError(({ code, set }) => {
    if (code === 'VALIDATION') {
      set.status = 400;
      return { error: 'request body validation failed' };
    }
  })
  .post(
    '/learn',
    async ({ body, set }) => {
      try {
        const data = (body ?? {}) as Record<string, any>;
        if (typeof data.pattern !== 'string' || data.pattern.trim() === '') {
          set.status = 400;
          return { error: 'pattern must be a non-empty string' };
        }
        if (data.idempotency_key !== undefined
          && (typeof data.idempotency_key !== 'string' || data.idempotency_key.trim() === '')) {
          set.status = 400;
          return { error: 'idempotency_key must be a non-empty string when provided' };
        }
        const result = await handleLearn(
          data.pattern,
          data.source,
          data.concepts,
          data.origin,
          data.project,
          data.cwd,
          data.idempotency_key,
        );
        if ('outcome' in result) {
          set.status = httpStatusForLearn(result);
          if (result.outcome === 'partial') {
            set.headers['Retry-After'] = '1';
          }
        }
        return result;
      } catch (error) {
        set.status = error instanceof LearnConflictError ? 409 : 503;
        return {
          success: false,
          outcome: error instanceof LearnConflictError ? 'conflict' : 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
    {
      body: LearnBody,
      detail: {
        tags: ['knowledge'],
        menu: { group: 'hidden' },
        summary: 'Record a learning pattern',
      },
    },
  );
