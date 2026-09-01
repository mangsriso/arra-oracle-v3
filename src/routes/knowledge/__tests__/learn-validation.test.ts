import { describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { learnEndpoint } from '../learn.ts';
import { LearnBody } from '../model.ts';

const app = new Elysia().use(learnEndpoint);

describe('HTTP learn input contract', () => {
  it('publishes string schema types for pattern and idempotency_key', () => {
    const properties = (LearnBody as any).properties;
    expect(properties.pattern.type).toBe('string');
    expect(properties.idempotency_key.type).toBe('string');
  });
  for (const body of [{}, { pattern: null }, { pattern: 42 }, { pattern: '   ' }]) {
    it(`returns 400 for invalid pattern ${JSON.stringify(body)}`, async () => {
      const response = await app.handle(new Request('http://localhost/learn', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }));
      expect(response.status).toBe(400);
      expect((await response.json() as any).error).toBeTruthy();
    });
  }

  for (const idempotency_key of [null, 42, '', '   ']) {
    it(`returns 400 for invalid idempotency key ${JSON.stringify(idempotency_key)}`, async () => {
      const response = await app.handle(new Request('http://localhost/learn', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pattern: 'valid', idempotency_key }),
      }));
      expect(response.status).toBe(400);
      expect((await response.json() as any).error).toBeTruthy();
    });
  }
});
