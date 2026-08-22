/**
 * HTTP route-level RED/GREEN gate for the FTS5 query sanitizer fix
 * (plan fable_FIX-PLAN-R2_sanitizer.md Part 1.4 / Part 3(b)). Not in CI
 * (Part 10 Q4) — run directly with `bun test tests/http/search-fts.test.ts`
 * or `bun run test:http`.
 *
 * Boots the REAL Elysia app (src/server.ts) as a subprocess with its own
 * port/HOME/empty DB (startIsolatedHttpServer) — ORACLE_DISABLE_LOCAL_VECTOR
 * is baked into the isolated runtime env, so the vector leg never runs here;
 * this file exercises route sanitize -> handlers.handleSearch -> FTS ->
 * response shape end-to-end, without touching the live DB or server.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  startIsolatedHttpServer,
  type IsolatedHttpServer,
} from '../support/isolated-http-server.ts';

let BASE_URL = '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const SEED_TAG = `search-fts-http-test-${Date.now()}`;
let fixture: IsolatedHttpServer | null = null;

const post = (url: string, body: unknown) =>
  fetch(`${BASE_URL}${url}`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });

// 9 chars that survive the LEGACY HTTP deny-list (src/server/handlers.ts,
// pre-fix: `[?*+\-()^~"':;<>{}[\]\\\/]`) and crash FTS5 MATCH when they
// reach oracle_fts unquoted (plan Part 0.5 probe1).
const HTTP_SURVIVING_KILLERS = ['=', ',', '$', '#', '%', '&', '!', '@', '|'];

describe('HTTP route — GET /api/search FTS5 sanitizer (RED/GREEN gate)', () => {
  beforeAll(async () => {
    fixture = await startIsolatedHttpServer('oracle-search-fts-http');
    BASE_URL = fixture.baseUrl;
    const res = await post('/api/learn', {
      pattern: `${SEED_TAG} EfficientIP check=1 DHCP overwrite production gotcha`,
      source: SEED_TAG,
      concepts: [SEED_TAG],
    });
    if (!res.ok) throw new Error(`seed failed (${res.status}): ${await res.text()}`);
  }, 30_000);

  afterAll(async () => {
    if (fixture) await fixture.stop();
  });

  test('H1: seeded-tag sanity (control) — finds the seeded doc', async () => {
    const res = await fetch(`${BASE_URL}/api/search?q=${encodeURIComponent(SEED_TAG)}&mode=fts`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.results.length).toBeGreaterThanOrEqual(1);
  }, 15_000);

  test('H2: check=1 class — special char survives to a real match, top hit is the seeded doc', async () => {
    const res = await fetch(`${BASE_URL}/api/search?q=${encodeURIComponent('check=1')}&mode=fts`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.results.length).toBeGreaterThanOrEqual(1);
    expect(data.results[0].content).toContain(SEED_TAG);
  }, 15_000);

  test('H3: battery — the 9 HTTP-surviving killer chars never 400', async () => {
    for (const ch of HTTP_SURVIVING_KILLERS) {
      const q = `p${ch}2`;
      const res = await fetch(`${BASE_URL}/api/search?q=${encodeURIComponent(q)}&mode=fts`);
      expect(res.status, `char ${JSON.stringify(ch)} (q=${JSON.stringify(q)}) -> ${res.status}`).toBe(200);
    }
  }, 20_000);

  test('H4: check=1 class under mode=hybrid — vector leg disabled, FTS leg still answers', async () => {
    const res = await fetch(`${BASE_URL}/api/search?q=${encodeURIComponent('check=1')}&mode=hybrid`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.vectorAvailable).toBe(false);
    expect(data.results.length).toBeGreaterThanOrEqual(1);
  }, 15_000);

  test('H5: symbol-only query (???) under mode=hybrid — no 5xx, empty results (no regression on removed early-return)', async () => {
    const res = await fetch(`${BASE_URL}/api/search?q=${encodeURIComponent('???')}&mode=hybrid`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.results).toEqual([]);
  }, 15_000);
});
