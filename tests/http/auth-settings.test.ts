// HTTP contract tests for auth / settings / feed.
// Isolated port + temp data dir so auth state does not leak between runs.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startIsolatedHttpServer,
  type IsolatedHttpServer,
} from "../support/isolated-http-server.ts";

let BASE_URL = "";
const PASSWORD = "contract-test-pw";

let fixture: IsolatedHttpServer | null = null;
let sessionCookie = "";

function extractCookie(res: Response): string {
  const raw = res.headers.get("set-cookie") || "";
  const match = raw.match(/oracle_session=([^;]+)/);
  return match ? `oracle_session=${match[1]}` : "";
}

async function json(path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sessionCookie) headers.cookie = sessionCookie;
  Object.assign(headers, (init.headers as Record<string, string>) || {});
  return fetch(`${BASE_URL}${path}`, { ...init, headers });
}

describe("HTTP contract: auth / settings / feed", () => {
  beforeAll(async () => {
    fixture = await startIsolatedHttpServer("oracle-auth-http");
    BASE_URL = fixture.baseUrl;
  }, 30_000);

  afterAll(async () => {
    if (fixture) await fixture.stop();
  });

  describe("GET /api/auth/status", () => {
    test("returns auth state on fresh install", async () => {
      const res = await fetch(`${BASE_URL}/api/auth/status`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data).toHaveProperty("authenticated");
      expect(data).toHaveProperty("authEnabled");
      expect(data).toHaveProperty("hasPassword");
      expect(data).toHaveProperty("localBypass");
      expect(data).toHaveProperty("isLocal");
      expect(data.authEnabled).toBe(false);
      expect(data.hasPassword).toBe(false);
      expect(data.isLocal).toBe(true);
    });
  });

  describe("POST /api/settings — configure auth", () => {
    test("rejects enabling auth when no password is set", async () => {
      const res = await json("/api/settings", {
        method: "POST",
        body: JSON.stringify({ authEnabled: true }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/password/i);
    });

    test("sets a password when none exists", async () => {
      const res = await json("/api/settings", {
        method: "POST",
        body: JSON.stringify({ newPassword: PASSWORD }),
      });
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.hasPassword).toBe(true);
    });

    test("enables auth and disables local bypass", async () => {
      const res = await json("/api/settings", {
        method: "POST",
        body: JSON.stringify({ authEnabled: true, localBypass: false }),
      });
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.authEnabled).toBe(true);
      expect(data.localBypass).toBe(false);
    });
  });

  describe("Auth flow", () => {
    test("GET /api/settings unauthed returns 401", async () => {
      const res = await fetch(`${BASE_URL}/api/settings`);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.requiresAuth).toBe(true);
    });

    test("POST /api/auth/login with no password returns 400", async () => {
      const res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.success).toBe(false);
    });

    test("POST /api/auth/login with wrong password returns 401", async () => {
      const res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "wrong" }),
      });
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toMatch(/invalid/i);
    });

    test("POST /api/auth/login with correct password sets session cookie", async () => {
      const res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      });
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.success).toBe(true);
      sessionCookie = extractCookie(res);
      expect(sessionCookie).toContain("oracle_session=");
    });

    test("authenticated request to /api/settings succeeds", async () => {
      const res = await json("/api/settings");
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.authEnabled).toBe(true);
    });

    test("POST /api/auth/logout clears the session", async () => {
      const res = await fetch(`${BASE_URL}/api/auth/logout`, {
        method: "POST",
        headers: { cookie: sessionCookie },
      });
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.success).toBe(true);
      const setCookie = res.headers.get("set-cookie") || "";
      // Delete cookie sets Max-Age=0 or an expired date
      expect(setCookie.toLowerCase()).toMatch(/max-age=0|expires=/);
      sessionCookie = "";
    });

    test("after logout, /api/settings is 401 again", async () => {
      const res = await fetch(`${BASE_URL}/api/settings`);
      expect(res.status).toBe(401);
    });
  });

  describe("Feed routes", () => {
    test("re-login to exercise feed endpoints", async () => {
      const res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      });
      expect(res.ok).toBe(true);
      sessionCookie = extractCookie(res);
    });

    test("GET /api/feed returns events array shape", async () => {
      const res = await json("/api/feed?limit=10");
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(Array.isArray(data.events)).toBe(true);
      expect(typeof data.total).toBe("number");
      expect(Array.isArray(data.active_oracles)).toBe(true);
    }, 10_000);

    test("GET /api/feed unauthed returns 401", async () => {
      const res = await fetch(`${BASE_URL}/api/feed`);
      expect(res.status).toBe(401);
    });

    test("POST /api/feed without required fields returns 400", async () => {
      const res = await json("/api/feed", {
        method: "POST",
        body: JSON.stringify({ project: "x" }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/oracle|event/i);
    });

    test("POST /api/feed with required fields appends an event", async () => {
      const res = await json("/api/feed", {
        method: "POST",
        body: JSON.stringify({
          oracle: "test-oracle",
          event: "test",
          project: "http-contract",
          message: "contract test ping",
        }),
      });
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(typeof data.timestamp).toBe("string");
    });
  });
});
