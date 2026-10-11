/**
 * Event-loop lag sampler. Synchronous SQLite FTS has blocked the loop for up to
 * 79 s; an external probe cannot see that, so measure drift of a 1 s timer.
 * Appends one JSONL line per minute (and immediately on lag > 5 s) to
 * ${ORACLE_DATA_DIR}/looplag/YYYY-MM-DD.jsonl. Best effort: never throws.
 * Disable with ORACLE_LOOPLAG=0.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface LoopLagOptions {
  dir: string;
  intervalMs?: number;
  windowMs?: number;
  now?: () => number; // monotonic ms
  wall?: () => Date;
}

export function createLoopLagSampler(opts: LoopLagOptions) {
  const intervalMs = opts.intervalMs ?? 1000;
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? (() => performance.now());
  const wall = opts.wall ?? (() => new Date());
  let last = now();
  let windowStart = last;
  let max = 0, n1 = 0, n5 = 0;
  let lastWindowMax: number | null = null;
  let today = '', over5Today = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  function flush(t: number) {
    const d = wall();
    const day = d.toLocaleDateString("sv-SE"); // local date (YYYY-MM-DD), matches the Asia/Bangkok daily rollup
    if (day !== today) { today = day; over5Today = 0; }
    over5Today += n5;
    lastWindowMax = max;
    const line = JSON.stringify({
      ts: d.toISOString(), window_s: Math.round((t - windowStart) / 1000),
      max_lag_ms: Math.round(max), n_over_1s: n1, n_over_5s: n5, pid: process.pid,
    });
    try {
      fs.mkdirSync(opts.dir, { recursive: true });
      fs.appendFileSync(path.join(opts.dir, `${day}.jsonl`), line + '\n');
    } catch { /* best effort */ }
    windowStart = t; max = 0; n1 = 0; n5 = 0;
  }

  /** One sample; exported for tests (driven by injected clock). */
  function tick() {
    try {
      const t = now();
      const lag = Math.max(0, t - last - intervalMs);
      last = t;
      if (lag > max) max = lag;
      if (lag > 1000) n1++;
      if (lag > 5000) n5++;
      if (lag > 5000 || t - windowStart >= windowMs) flush(t);
    } catch { /* never throw into the server */ }
  }

  function status() {
    return {
      max_lag_ms_last_min: Math.round(lastWindowMax ?? max),
      n_over_5s_today: over5Today + n5,
    };
  }

  function start() {
    if (timer) return;
    last = windowStart = now();
    timer = setInterval(tick, intervalMs);
    timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = undefined; }

  return { tick, start, stop, status };
}

let instance: ReturnType<typeof createLoopLagSampler> | null = null;

/** Start the process-wide sampler unless ORACLE_LOOPLAG=0. */
export function startLoopLag(dataDir: string, env: Record<string, string | undefined> = process.env) {
  if (env.ORACLE_LOOPLAG === '0' || instance) return instance;
  instance = createLoopLagSampler({ dir: path.join(dataDir, 'looplag') });
  instance.start();
  return instance;
}

export function getLoopLagStatus() {
  return instance?.status() ?? null;
}
