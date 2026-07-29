import { Elysia } from 'elysia';
import { FEED_LOG } from '../../config.ts';
import { FeedQuery, type FeedEvent } from './model.ts';
import {
  activeOracles,
  compareFeedEvents,
  feedEventMatches,
  readLocalFeedTail,
} from './reader.ts';

const MAW_JS_URL = process.env.MAW_JS_URL || 'http://localhost:3456';
const FEED_MAX_READ_BYTES = boundedEnv('ORACLE_FEED_MAX_READ_BYTES', 1024 * 1024, 4096, 16 * 1024 * 1024);
const MAW_FEED_TIMEOUT_MS = boundedEnv('MAW_JS_FEED_TIMEOUT_MS', 500, 50, 5000);

function boundedEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

async function readMawFeed(filters: {
  oracle?: string;
  event?: string;
  since?: string;
}): Promise<{ events: FeedEvent[]; total: number; totalExact: boolean }> {
  try {
    const mawRes = await fetch(`${MAW_JS_URL}/api/feed?limit=100`, {
      signal: AbortSignal.timeout(MAW_FEED_TIMEOUT_MS),
    });
    if (!mawRes.ok) return { events: [], total: 0, totalExact: false };

    const mawData = await mawRes.json() as any;
    if (!Array.isArray(mawData.events)) return { events: [], total: 0, totalExact: false };
    const events: FeedEvent[] = mawData.events.map((e: any) => ({
      timestamp: e.timestamp || new Date(e.ts).toISOString().replace('T', ' ').slice(0, 19),
      oracle: e.oracle,
      host: e.host,
      event: e.event,
      project: e.project,
      session_id: e.sessionId,
      message: e.message,
      source: 'maw-js',
    })).filter((mawEvent: FeedEvent) => feedEventMatches(mawEvent, filters));
    const hasFilters = Boolean(filters.oracle || filters.event || filters.since);
    const upstreamExact = mawData.total_exact === true && !hasFilters;
    return {
      events,
      total: upstreamExact && Number.isInteger(mawData.total) ? mawData.total : events.length,
      totalExact: upstreamExact,
    };
  } catch (mawError) {
    console.log('maw-js feed unavailable:', mawError);
    return { events: [], total: 0, totalExact: false };
  }
}

export const listFeedRoute = new Elysia().get('/', async ({ query, set }) => {
  try {
    const parsedLimit = parseInt(query.limit || '50');
    const limit = Number.isNaN(parsedLimit) ? 0 : Math.max(0, Math.min(200, parsedLimit));
    const oracle = query.oracle || undefined;
    const event = query.event || undefined;
    const since = query.since || undefined;
    const filters = { oracle, event, since };

    // Bound the local read and overlap it with the optional upstream request.
    const [local, maw] = await Promise.all([
      readLocalFeedTail(FEED_LOG, limit, filters, FEED_MAX_READ_BYTES),
      readMawFeed(filters),
    ]);
    let allEvents: FeedEvent[] = [...local.events, ...maw.events];
    const total = local.total + maw.total;

    allEvents.sort(compareFeedEvents);
    allEvents = allEvents.slice(0, limit);
    return {
      events: allEvents,
      total,
      total_exact: local.totalExact && maw.totalExact,
      local_truncated: local.truncated,
      active_oracles: activeOracles(allEvents),
    };
  } catch (e: any) {
    set.status = 500;
    return { error: e.message, events: [], total: 0 };
  }
}, {
  query: FeedQuery,
  detail: {
    tags: ['feed'],
    menu: { group: 'hidden' },
    summary: 'Merged local + maw-js feed events',
  },
});
