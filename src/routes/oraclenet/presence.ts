import { Elysia } from 'elysia';
import { fetchOracleNetJson, oracleNetFailure } from './client.ts';

export const presenceEndpoint = new Elysia().get('/presence', async ({ set }) => {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const result = await fetchOracleNetJson(
    `/api/collections/heartbeats/records?filter=(created>='${fiveMinAgo}')&expand=oracle&sort=-created&perPage=50`,
  );
  if (!result.ok) {
    const failure = oracleNetFailure(result.kind);
    set.status = failure.status;
    return failure.body;
  }
  return result.data;
}, {
  detail: {
    tags: ['oraclenet'],
    menu: { group: 'hidden' },
    summary: 'Active oracle presence heartbeats',
  },
});
