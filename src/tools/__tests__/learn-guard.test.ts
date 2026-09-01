/**
 * handleLearn input guard — locks the arra_learn contract at the MCP boundary.
 *
 * Regression origin (2026-08-14): a caller sent {title, content, tags} (the
 * Claude Code auto-memory shape) instead of the schema's {pattern, source,
 * concepts, project}. dispatch.ts casts arguments without validating them, so
 * `pattern` arrived undefined and `pattern.substring(0, 50)` threw
 * "undefined is not an object (evaluating 'pattern.substring')" — an opaque
 * TypeError that reads like a broken tool and cost a real misdiagnosis.
 *
 * Hermetic by construction: every case here is REJECTED by the guard, which
 * returns before touching ctx, the filesystem, SQLite, or the vector store.
 * That is exactly what the last test asserts — a dummy ctx whose members would
 * throw if touched proves no write path is reached on rejection.
 */

import { describe, it, expect } from 'bun:test';
import { handleLearn, learnToolDef } from '../learn.ts';
import type { ToolContext } from '../types.ts';

// Any access to this ctx throws — so a passing test proves the guard returned
// before the handler used it for anything.
const TRIPWIRE_CTX = new Proxy({}, {
  get(_t, prop) {
    throw new Error(`guard leaked: handler touched ctx.${String(prop)} on a rejected input`);
  },
}) as unknown as ToolContext;

const rejects = async (input: unknown) =>
  handleLearn(TRIPWIRE_CTX, input as Parameters<typeof handleLearn>[1]);

describe('handleLearn guard — rejected inputs', () => {
  it('rejects the original {title, content, tags} regression shape', async () => {
    const res = await rejects({ title: 't', content: 'c', tags: ['x'] });
    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    // must name the offending keys so the caller can self-correct
    expect(text).toContain('title');
    expect(text).toContain('content');
    expect(text).toContain('tags');
    expect(text).toContain('pattern');
    // must NOT be the old opaque TypeError
    expect(text).not.toContain('is not an object');
  });

  it.each([
    ['missing pattern', {}],
    ['null pattern', { pattern: null }],
    ['undefined pattern', { pattern: undefined }],
    ['empty string', { pattern: '' }],
    ['whitespace only', { pattern: '   \t \n ' }],
    ['number', { pattern: 42 }],
    ['boolean', { pattern: true }],
    ['object', { pattern: {} }],
    ['array', { pattern: [] }],
    ['null input', null],
    ['undefined input', undefined],
  ])('rejects %s', async (_label, input) => {
    const res = await rejects(input);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('requires a non-empty string "pattern"');
  });

  it('never throws — always returns a structured ToolResponse', async () => {
    for (const input of [null, undefined, {}, { pattern: 1 }, 'a string', 42]) {
      const res = await rejects(input);
      expect(res.isError).toBe(true);
      expect(Array.isArray(res.content)).toBe(true);
      expect(res.content[0].type).toBe('text');
    }
  });
});

describe('learnToolDef schema matches the guard', () => {
  it('declares pattern required, string, minLength 1', () => {
    // Discovery must not advertise something the runtime rejects.
    expect(learnToolDef.inputSchema.required).toEqual(['pattern']);
    const p = learnToolDef.inputSchema.properties.pattern;
    expect(p.type).toBe('string');
    expect(p.minLength).toBe(1);
  });

  it('does not advertise title/content/tags', () => {
    const keys = Object.keys(learnToolDef.inputSchema.properties);
    expect(keys).toEqual(['pattern', 'source', 'concepts', 'project', 'idempotency_key']);
  });
});
