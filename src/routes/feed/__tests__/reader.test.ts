import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FeedEvent } from '../model.ts';
import { activeOracles, readLocalFeed, readLocalFeedTail } from '../reader.ts';

let fixtureDir = '';

afterEach(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = '';
});

function makeFixture(lines: number): string {
  fixtureDir = mkdtempSync(join(tmpdir(), 'oracle-feed-reader-'));
  const file = join(fixtureDir, 'feed.log');
  const rows: string[] = [];
  for (let index = 0; index < lines; index++) {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    const oracle = index % 2 === 0 ? 'wednesday' : 'fester';
    const event = index % 3 === 0 ? 'search' : 'read';
    rows.push(`${timestamp} | ${oracle} | host | ${event} | project | s-${index} » m-${index}`);
  }
  writeFileSync(file, rows.join('\n') + '\n');
  return file;
}

describe('streamed local feed reader', () => {
  test('keeps exact filtered total while retaining only newest limited events', async () => {
    const file = makeFixture(10_000);
    const since = '2026-01-01 02:00:00';
    const result = await readLocalFeed(file, 7, {
      oracle: 'wednesday',
      event: 'search',
      since,
    });

    const expectedIndexes = Array.from({ length: 10_000 }, (_, index) => index)
      .filter((index) => index % 2 === 0 && index % 3 === 0)
      .filter((index) => {
        const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
          .replace('T', ' ')
          .slice(0, 19);
        return timestamp >= since;
      });

    expect(result.total).toBe(expectedIndexes.length);
    expect(result.events).toHaveLength(7);
    expect(result.events.map((event) => event.session_id)).toEqual(
      expectedIndexes.slice(-7).reverse().map((index) => `s-${index}`),
    );
  });

  test('derives active oracles only from the limited result set', () => {
    const now = Date.UTC(2026, 6, 29, 12, 0, 0);
    const event = (oracle: string, timestamp: string): FeedEvent => ({
      timestamp,
      oracle,
      host: 'host',
      event: 'search',
      project: 'project',
      session_id: 'session',
      message: 'message',
      source: 'local',
    });
    const limited = [
      event('wednesday', '2026-07-29 11:59:00'),
      event('fester', '2026-07-29 11:56:00'),
      event('thing', '2026-07-29 11:40:00'),
      event('wednesday', '2026-07-29 11:58:00'),
    ];

    expect(activeOracles(limited, now)).toEqual(['wednesday', 'fester']);
  });

  test('bounds tail reads and labels an incomplete total honestly', async () => {
    const file = makeFixture(10_000);
    const result = await readLocalFeedTail(file, 1, {}, 512);

    expect(result.scannedBytes).toBeLessThanOrEqual(512);
    expect(result.truncated).toBe(true);
    expect(result.totalExact).toBe(false);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].session_id).toBe('s-9999');
  });

  test('keeps an exact total for files inside the read budget', async () => {
    const file = makeFixture(20);
    const result = await readLocalFeedTail(file, 2, {}, 64 * 1024);

    expect(result.total).toBe(20);
    expect(result.totalExact).toBe(true);
    expect(result.truncated).toBe(false);
  });
});
