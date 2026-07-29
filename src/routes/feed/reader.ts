import type { FeedEvent } from './model.ts';

export interface FeedFilters {
  oracle?: string;
  event?: string;
  since?: string;
}

interface RankedEvent {
  event: FeedEvent;
  sequence: number;
  timestamp: number;
}

export function parseFeedLine(line: string): FeedEvent {
  const [ts, oracleName, host, eventType, project, rest] = line
    .split(' | ')
    .map((value) => value.trim());
  const [sessionId, ...messageParts] = (rest || '').split(' » ');
  return {
    timestamp: ts,
    oracle: oracleName,
    host,
    event: eventType,
    project,
    session_id: sessionId?.trim(),
    message: messageParts.join(' » ').trim(),
    source: 'local',
  };
}

export function feedEventMatches(event: FeedEvent, filters: FeedFilters): boolean {
  if (filters.oracle && event.oracle !== filters.oracle) return false;
  if (filters.event && event.event !== filters.event) return false;
  if (filters.since && event.timestamp < filters.since) return false;
  return true;
}

export function compareFeedEvents(a: FeedEvent, b: FeedEvent): number {
  return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
}

function isWorse(a: RankedEvent, b: RankedEvent): boolean {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp;
  return a.sequence > b.sequence;
}

function siftUp(heap: RankedEvent[], index: number): void {
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (!isWorse(heap[index], heap[parent])) break;
    [heap[index], heap[parent]] = [heap[parent], heap[index]];
    index = parent;
  }
}

function siftDown(heap: RankedEvent[], index: number): void {
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let worst = index;
    if (left < heap.length && isWorse(heap[left], heap[worst])) worst = left;
    if (right < heap.length && isWorse(heap[right], heap[worst])) worst = right;
    if (worst === index) return;
    [heap[index], heap[worst]] = [heap[worst], heap[index]];
    index = worst;
  }
}

function retainNewest(heap: RankedEvent[], candidate: RankedEvent, limit: number): void {
  if (limit === 0) return;
  if (heap.length < limit) {
    heap.push(candidate);
    siftUp(heap, heap.length - 1);
    return;
  }
  if (isWorse(candidate, heap[0])) return;
  heap[0] = candidate;
  siftDown(heap, 0);
}

async function* readLines(filePath: string): AsyncGenerator<string> {
  const reader = Bun.file(filePath).stream().getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline).replace(/\r$/, '');
        buffered = buffered.slice(newline + 1);
        yield line;
        newline = buffered.indexOf('\n');
      }
    }
    buffered += decoder.decode();
    if (buffered) yield buffered.replace(/\r$/, '');
  } finally {
    reader.releaseLock();
  }
}

export async function readLocalFeed(
  filePath: string,
  limit: number,
  filters: FeedFilters = {},
): Promise<{ events: FeedEvent[]; total: number }> {
  const heap: RankedEvent[] = [];
  let sequence = 0;
  let total = 0;

  for await (const line of readLines(filePath)) {
    if (!line) continue;
    const event = parseFeedLine(line);
    const currentSequence = sequence++;
    if (!feedEventMatches(event, filters)) continue;
    total += 1;
    const parsedTimestamp = new Date(event.timestamp).getTime();
    retainNewest(heap, {
      event,
      sequence: currentSequence,
      timestamp: Number.isNaN(parsedTimestamp) ? Number.NEGATIVE_INFINITY : parsedTimestamp,
    }, limit);
  }

  heap.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
    return a.sequence - b.sequence;
  });
  return { events: heap.map(({ event }) => event), total };
}

export function activeOracles(events: FeedEvent[], now: number = Date.now()): string[] {
  const cutoff = new Date(now - 5 * 60_000).toISOString().replace('T', ' ').slice(0, 19);
  return [...new Set(events.filter((event) => event.timestamp >= cutoff).map((event) => event.oracle))];
}
