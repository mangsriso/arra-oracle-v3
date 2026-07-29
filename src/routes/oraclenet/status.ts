import { Elysia } from 'elysia';
import { fetchOracleNet } from './client.ts';
import { ORACLENET_URL } from './model.ts';

export const statusEndpoint = new Elysia().get('/status', async () => {
  const result = await fetchOracleNet('/api/health');
  if (result.ok) return { online: true, url: ORACLENET_URL };
  return { online: false, url: ORACLENET_URL, reason: result.kind };
}, {
  detail: {
    tags: ['oraclenet'],
    menu: { group: 'hidden' },
    summary: 'OracleNet upstream health',
  },
});
