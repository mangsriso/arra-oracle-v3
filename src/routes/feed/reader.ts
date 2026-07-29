import type { FeedEvent } from './model.ts';
import { open } from 'node:fs/promises';

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

export interface LocalFeedWindow {
  events: FeedEvent[];
  /** Number of matching rows in the scanned window. */
  total: number;
  /** True only when the entire file was scanned. */
  totalExact: boolean;
  scannedBytes: number;
  truncated: boolean;
}

/**
 * Read a bounded tail window for latency-sensitive HTTP requests.
 *
 * feed.log is append-only and chronological in normal operation, so the tail
 * contains the newest records needed by small limits. Filters may match only
 * older records; in that case the result is deliberately marked inexact
 * instead of scanning an unbounded file and hiding the cost.
 */
export async function readLocalFeedTail(
  filePath: string,
  limit: number,
  filters: FeedFilters = {},
  maxBytes = 1024 * 1024,
): Promise<LocalFeedWindow> {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`Feed tail maxBytes must be a positive integer: ${maxBytes}`);
  }

  let file;
  try {
    file = await open(filePath, 'r');
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return {
        events: [],
        total: 0,
        totalExact: true,
        scannedBytes: 0,
        truncated: false,
      };
    }
    throw error;
  }

  try {
    const stat = await file.stat();
    const start = Math.max(0, stat.size - maxBytes);
    const bytesToRead = stat.size - start;
    if (start === 0) {
      const full = await readLocalFeed(filePath, limit, filters);
      return {
        ...full,
        totalExact: true,
        scannedBytes: bytesToRead,
        truncated: false,
      };
    }

    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await file.read(buffer, 0, bytesToRead, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    const firstNewline = text.indexOf('\n');
    if (firstNewline < 0) {
      return {
        events: [],
        total: 0,
        totalExact: false,
        scannedBytes: bytesRead,
        truncated: true,
      };
    }
    text = text.slice(firstNewline + 1);

    const heap: RankedEvent[] = [];
    let sequence = 0;
    let total = 0;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
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
    return {
      events: heap.map(({ event }) => event),
      total,
      totalExact: false,
      scannedBytes: bytesRead,
      truncated: true,
    };
  } finally {
    await file.close();
  }
}

export function activeOracles(events: FeedEvent[], now: number = Date.now()): string[] {
  const cutoff = new Date(now - 5 * 60_000).toISOString().replace('T', ' ').slice(0, 19);
  return [...new Set(events.filter((event) => event.timestamp >= cutoff).map((event) => event.oracle))];
}
