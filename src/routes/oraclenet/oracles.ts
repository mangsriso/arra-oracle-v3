import { Elysia } from 'elysia';
import { fetchOracleNetJson, oracleNetFailure } from './client.ts';
import { OraclesQuery } from './model.ts';

export const oraclesEndpoint = new Elysia().get('/oracles', async ({ query, set }) => {
  const limit = query.limit ?? '50';
  const result = await fetchOracleNetJson(
    `/api/collections/oracles/records?perPage=${limit}&sort=-karma`,
  );
  if (!result.ok) {
    const failure = oracleNetFailure(result.kind);
    set.status = failure.status;
    return failure.body;
  }
  return result.data;
}, {
  query: OraclesQuery,
  detail: {
    tags: ['oraclenet'],
    menu: { group: 'hidden' },
    summary: 'Proxy OracleNet oracle records',
  },
});
