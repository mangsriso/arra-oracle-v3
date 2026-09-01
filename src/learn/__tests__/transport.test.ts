import { describe, expect, it } from 'bun:test';
import { httpStatusForLearn, mcpLearnResponse } from '../transport.ts';
import type { LearnPersistenceResult } from '../persistence.ts';

function outcome(kind: LearnPersistenceResult['outcome']): LearnPersistenceResult {
  const success = kind !== 'partial';
  return {
    success,
    outcome: kind,
    file: 'ψ/memory/learnings/test.md',
    id: 'learning_test',
    embedding: success ? 'enqueued' : 'failed',
    durability: {
      level: success ? 'full' : 'file', content_hash: 'hash', request_fingerprint: 'fingerprint',
    },
    indexing: {
      status: success ? 'pending' : 'missing', job_id: success ? 'job' : null,
      model_key: 'test', index_revision: 'revision',
    },
    replayed: kind === 'replayed',
    reconciled: kind === 'reconciled',
  };
}

describe('learn transport presentation', () => {
  it('preserves MCP legacy embedding field and structured async details', () => {
    const response = mcpLearnResponse(outcome('created'));
    const body = JSON.parse(response.content[0].text);
    expect(response.isError).toBeUndefined();
    expect(body.embedding).toBe('enqueued');
    expect(body.indexing.job_id).toBe('job');
    expect(body.durability.level).toBe('full');
  });

  it('maps partial to MCP isError and HTTP 503 without losing durable identity', () => {
    const result = outcome('partial');
    const response = mcpLearnResponse(result);
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toMatchObject({
      file: result.file, id: result.id, outcome: 'partial',
    });
    expect(httpStatusForLearn(result)).toBe(503);
  });

  it('maps create/replay/reconcile to 201/200/200', () => {
    expect(httpStatusForLearn(outcome('created'))).toBe(201);
    expect(httpStatusForLearn(outcome('replayed'))).toBe(200);
    expect(httpStatusForLearn(outcome('reconciled'))).toBe(200);
  });
});
