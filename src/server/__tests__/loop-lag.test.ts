import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoopLagSampler, startLoopLag } from '../loop-lag.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'looplag-'));
const lines = (dir: string) =>
  fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));

function clocked(dir: string) {
  let t = 0;
  const s = createLoopLagSampler({ dir, now: () => t, wall: () => new Date('2026-10-06T00:00:00Z') });
  return { s, advance: (ms: number) => { t += ms; s.tick(); } };
}

describe('loop-lag drift math', () => {
  test('on-time ticks produce zero lag; late ticks count by threshold', () => {
    const dir = tmp();
    const { s, advance } = clocked(dir);
    advance(1000); advance(1000);
    expect(s.status().max_lag_ms_last_min).toBe(0);
    advance(2500); // lag 1500
    expect(s.status().max_lag_ms_last_min).toBe(1500);
    advance(1000);
    advance(1000 + 5001); // lag 5001 -> immediate flush
    const rows = lines(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ n_over_1s: 2, n_over_5s: 1, max_lag_ms: 5001, pid: process.pid });
    expect(s.status().n_over_5s_today).toBe(1);
  });

  test('exactly 5000 ms lag is not over 5 s, exactly 1000 not over 1 s', () => {
    const dir = tmp();
    const { s, advance } = clocked(dir);
    advance(2000); advance(6000);
    expect(s.status().n_over_5s_today).toBe(0);
    expect(fs.readdirSync(dir)).toHaveLength(0); // no flush, no write
  });

  test('flushes one JSONL line per minute window', () => {
    const dir = tmp();
    const { advance } = clocked(dir);
    for (let i = 0; i < 61; i++) advance(1000);
    const rows = lines(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0].window_s).toBe(60);
    expect(path.basename(fs.readdirSync(dir)[0])).toBe('2026-10-06.jsonl');
  });

  test('unwritable dir never throws', () => {
    const file = path.join(tmp(), 'f');
    fs.writeFileSync(file, 'x');
    const { advance } = clocked(path.join(file, 'sub'));
    expect(() => advance(1000 + 6000)).not.toThrow();
  });
});

describe('loop-lag real timer', () => {
  test('synchronous busy-wait increments n_over_1s (lag = block - interval, so 2.5 s block => >=1.5 s lag)', async () => {
    const dir = tmp();
    const s = createLoopLagSampler({ dir, windowMs: 1 });
    s.start();
    await new Promise((r) => setTimeout(r, 1100));
    const end = Date.now() + 2500;
    while (Date.now() < end) { /* block the loop */ }
    await new Promise((r) => setTimeout(r, 1100));
    s.stop();
    const rows = lines(dir);
    expect(rows.reduce((a, r) => a + r.n_over_1s, 0)).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.max_lag_ms >= 1400)).toBe(true);
  });

  test('ORACLE_LOOPLAG=0 disables', () => {
    expect(startLoopLag(tmp(), { ORACLE_LOOPLAG: '0' })).toBeNull();
  });
});
