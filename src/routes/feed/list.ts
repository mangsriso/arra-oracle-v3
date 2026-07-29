import { Elysia } from 'elysia';
import { FEED_LOG } from '../../config.ts';
import { FeedQuery, type FeedEvent } from './model.ts';
import {
  activeOracles,
  compareFeedEvents,
  feedEventMatches,
  readLocalFeed,
} from './reader.ts';

const MAW_JS_URL = process.env.MAW_JS_URL || 'http://localhost:3456';

export const listFeedRoute = new Elysia().get('/', async ({ query, set }) => {
  try {
    const parsedLimit = parseInt(query.limit || '50');
    const limit = Number.isNaN(parsedLimit) ? 0 : Math.max(0, Math.min(200, parsedLimit));
    const oracle = query.oracle || undefined;
    const event = query.event || undefined;
    const since = query.since || undefined;
    const filters = { oracle, event, since };

    const local = await Bun.file(FEED_LOG).exists()
      ? await readLocalFeed(FEED_LOG, limit, filters)
      : { events: [], total: 0 };
    let allEvents: FeedEvent[] = [...local.events];
    let total = local.total;

    try {
      const mawRes = await fetch(`${MAW_JS_URL}/api/feed?limit=100`, { signal: AbortSignal.timeout(2000) });
      if (mawRes.ok) {
        const mawData = await mawRes.json() as any;
        if (mawData.events && Array.isArray(mawData.events)) {
          const mawEvents: FeedEvent[] = mawData.events.map((e: any) => ({
            timestamp: e.timestamp || new Date(e.ts).toISOString().replace('T', ' ').slice(0, 19),
            oracle: e.oracle,
            host: e.host,
            event: e.event,
            project: e.project,
            session_id: e.sessionId,
            message: e.message,
            source: 'maw-js',
          }));
          const matchingMawEvents = mawEvents.filter((mawEvent) => feedEventMatches(mawEvent, filters));
          total += matchingMawEvents.length;
          allEvents.push(...matchingMawEvents);
        }
      }
    } catch (mawError) {
      console.log('maw-js feed unavailable:', mawError);
    }

    allEvents.sort(compareFeedEvents);
    allEvents = allEvents.slice(0, limit);
    return { events: allEvents, total, active_oracles: activeOracles(allEvents) };
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
