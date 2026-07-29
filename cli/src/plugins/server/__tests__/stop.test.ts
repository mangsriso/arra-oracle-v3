import { describe, expect, test } from "bun:test";
import { stopOracleServer } from "../index.ts";

function mockFetch(
  handler: (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => Response | Promise<Response>,
): typeof fetch {
  return handler as typeof fetch;
}

describe("server stop", () => {
  test("reports success only for an ok response", async () => {
    let request: { url: string; method?: string } | undefined;
    const result = await stopOracleServer(false, mockFetch((input, init) => {
      request = { url: String(input), method: init?.method };
      return new Response(null, { status: 200 });
    }));

    expect(request?.url).toEndWith("/api/shutdown");
    expect(request?.method).toBe("POST");
    expect(result).toEqual({ ok: true, output: "Oracle server stopped." });
  });

  test("404 is a failed stop with stopped:false JSON", async () => {
    const result = await stopOracleServer(true, mockFetch(
      () => new Response("missing", { status: 404 }),
    ));

    expect(result.ok).toBe(false);
    expect(JSON.parse(result.error!)).toEqual({
      stopped: false,
      reason: "shutdown endpoint returned HTTP 404",
    });
  });

  test("other non-2xx responses also fail", async () => {
    const result = await stopOracleServer(false, mockFetch(
      () => new Response("unavailable", { status: 503 }),
    ));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("HTTP 503");
  });

  test("network errors fail instead of claiming success", async () => {
    const result = await stopOracleServer(true, mockFetch(
      () => Promise.reject(new TypeError("connection refused")),
    ));

    expect(result.ok).toBe(false);
    expect(JSON.parse(result.error!)).toEqual({
      stopped: false,
      reason: "not running or /api/shutdown unavailable",
    });
  });
});
