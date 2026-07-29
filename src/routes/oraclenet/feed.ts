import { Elysia } from 'elysia';
import { fetchOracleNetJson, oracleNetFailure } from './client.ts';
import { FeedQuery } from './model.ts';

export const feedEndpoint = new Elysia().get('/feed', async ({ query, set }) => {
  const sort = query.sort ?? '-created';
  const limit = query.limit ?? '20';
  const expand = 'author';
  const result = await fetchOracleNetJson(
    `/api/collections/posts/records?sort=${sort}&perPage=${limit}&expand=${expand}`,
  );
  if (!result.ok) {
    const failure = oracleNetFailure(result.kind);
    set.status = failure.status;
    return failure.body;
  }
  return result.data;
}, {
  query: FeedQuery,
  detail: {
    tags: ['oraclenet'],
    menu: { group: 'hidden' },
    summary: 'Proxy OracleNet feed records',
  },
});
