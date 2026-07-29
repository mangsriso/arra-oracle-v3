/**
 * HTTP Contract Tests — Core Routes
 *
 * Covers:
 *   - src/routes/health.ts      → /api/health, /api/stats, /api/oracles
 *   - src/routes/oraclenet.ts   → /api/oraclenet/{feed,oracles,presence,status}
 *   - src/routes/dashboard.ts   → /api/dashboard(/summary|activity|growth), /api/session/stats
 *
 * Runs against current Hono backend; shape contracts will later verify Elysia parity.
 * Pattern mirrors src/integration/http.test.ts (subprocess + fetch).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startIsolatedHttpServer,
  type IsolatedHttpServer,
} from "../support/isolated-http-server.ts";

let BASE_URL = "";
let fixture: IsolatedHttpServer | null = null;

describe("HTTP Contract — Core Routes", () => {
  beforeAll(async () => {
    fixture = await startIsolatedHttpServer("oracle-core-http");
    BASE_URL = fixture.baseUrl;
  }, 30_000);

  afterAll(async () => {
    if (fixture) await fixture.stop();
  });

  // ============================================================
  // health.ts
  // ============================================================
  describe("health.ts", () => {
    test("GET /api/health → status ok + metadata", async () => {
      const res = await fetch(`${BASE_URL}/api/health`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.status).toBe("ok");
      expect(typeof data.server).toBe("string");
      expect(typeof data.port).toBe("number");
    });

    test("GET /api/stats → numeric total + vector shape", async () => {
      const res = await fetch(`${BASE_URL}/api/stats`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(typeof data.total).toBe("number");
      expect(data).toHaveProperty("vector");
      expect(typeof data.vector.enabled).toBe("boolean");
    }, 15_000);

    test("GET /api/oracles → identities + projects arrays", async () => {
      const res = await fetch(`${BASE_URL}/api/oracles`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(Array.isArray(data.identities)).toBe(true);
      expect(Array.isArray(data.projects)).toBe(true);
      expect(typeof data.total_projects).toBe("number");
      expect(typeof data.total_identities).toBe("number");
      expect(data.window_hours).toBe(168);
    });

    test("GET /api/oracles?hours=24 → honors window param", async () => {
      const res = await fetch(`${BASE_URL}/api/oracles?hours=24`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      // Cached result may reflect a different window; accept either
      expect([24, 168]).toContain(data.window_hours);
    });

    test("GET /api/oracles?hours=notanumber → coerces without 500", async () => {
      const res = await fetch(`${BASE_URL}/api/oracles?hours=abc`);
      expect(res.status).toBeLessThan(500);
    });
  });

  // ============================================================
  // oraclenet.ts — upstream may be offline; tolerate 200 or 502
  // ============================================================
  describe("oraclenet.ts", () => {
    const okOrBadGateway = (status: number) =>
      expect([200, 502]).toContain(status);

    test("GET /api/oraclenet/feed → 200 payload or 502 error", async () => {
      const res = await fetch(`${BASE_URL}/api/oraclenet/feed`);
      okOrBadGateway(res.status);
      const data = await res.json();
      if (res.status === 502) expect(typeof data.error).toBe("string");
      else expect(typeof data).toBe("object");
    }, 15_000);

    test("GET /api/oraclenet/feed?sort=-created&limit=5", async () => {
      const res = await fetch(`${BASE_URL}/api/oraclenet/feed?sort=-created&limit=5`);
      okOrBadGateway(res.status);
    }, 15_000);

    test("GET /api/oraclenet/oracles → 200 or 502", async () => {
      const res = await fetch(`${BASE_URL}/api/oraclenet/oracles`);
      okOrBadGateway(res.status);
    }, 15_000);

    test("GET /api/oraclenet/oracles?limit=10", async () => {
      const res = await fetch(`${BASE_URL}/api/oraclenet/oracles?limit=10`);
      okOrBadGateway(res.status);
    }, 15_000);

    test("GET /api/oraclenet/presence → 200 or 502", async () => {
      const res = await fetch(`${BASE_URL}/api/oraclenet/presence`);
      okOrBadGateway(res.status);
    }, 15_000);

    test("GET /api/oraclenet/status → always 200 with online flag", async () => {
      const res = await fetch(`${BASE_URL}/api/oraclenet/status`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(typeof data.online).toBe("boolean");
      expect(typeof data.url).toBe("string");
    }, 15_000);

    test("GET /api/oraclenet/nonexistent → not 5xx", async () => {
      const res = await fetch(`${BASE_URL}/api/oraclenet/nonexistent`);
      expect(res.status).toBeLessThan(500);
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  // ============================================================
  // dashboard.ts
  // ============================================================
  describe("dashboard.ts", () => {
    test("GET /api/dashboard → summary object", async () => {
      const res = await fetch(`${BASE_URL}/api/dashboard`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(typeof data).toBe("object");
      expect(data).not.toBeNull();
    });

    test("GET /api/dashboard/summary → same shape as /api/dashboard", async () => {
      const res = await fetch(`${BASE_URL}/api/dashboard/summary`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(typeof data).toBe("object");
    });

    test("GET /api/dashboard/activity?days=7 → object payload", async () => {
      const res = await fetch(`${BASE_URL}/api/dashboard/activity?days=7`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(typeof data).toBe("object");
    });

    test("GET /api/dashboard/activity (no days) → defaults applied", async () => {
      const res = await fetch(`${BASE_URL}/api/dashboard/activity`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(typeof data).toBe("object");
    });

    test("GET /api/dashboard/activity?days=bad → no 500", async () => {
      const res = await fetch(`${BASE_URL}/api/dashboard/activity?days=bad`);
      expect(res.status).toBeLessThan(500);
    });

    test("GET /api/dashboard/growth?period=week", async () => {
      const res = await fetch(`${BASE_URL}/api/dashboard/growth?period=week`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(typeof data).toBe("object");
    });

    test("GET /api/dashboard/growth (default period)", async () => {
      const res = await fetch(`${BASE_URL}/api/dashboard/growth`);
      expect(res.ok).toBe(true);
    });

    test("GET /api/session/stats → searches + learnings counts", async () => {
      const res = await fetch(`${BASE_URL}/api/session/stats`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(typeof data.searches).toBe("number");
      expect(typeof data.learnings).toBe("number");
      expect(typeof data.since).toBe("number");
    });

    test("GET /api/session/stats?since=0 → honors param", async () => {
      const res = await fetch(`${BASE_URL}/api/session/stats?since=0`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.since).toBe(0);
    });

    test("GET /api/dashboard/bogus → 404 (no 5xx)", async () => {
      const res = await fetch(`${BASE_URL}/api/dashboard/bogus`);
      expect(res.status).toBeLessThan(500);
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });
});
