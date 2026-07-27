/**
 * HTTP Contract Tests — search, knowledge (learn/handoff/inbox), supersede.
 * Covers src/routes/{search,knowledge,supersede}.ts. Seeds via POST /api/learn,
 * reuses an already-running server on BASE_URL or spawns src/server.ts.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import path from "path";

const BASE_URL = "http://localhost:47778";
const JSON_HEADERS = { "Content-Type": "application/json" };
const SEED_TAG = `yellow-http-test-${Date.now()}`;
let serverProcess: Subprocess | null = null;

const isUp = async () => {
  try { return (await fetch(`${BASE_URL}/api/health`)).ok; } catch { return false; }
};

const waitUp = async (n = 30) => {
  for (let i = 0; i < n; i++) { if (await isUp()) return true; await Bun.sleep(500); }
  return false;
};

const post = (url: string, body: unknown) =>
  fetch(`${BASE_URL}${url}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });

/**
 * Everything this suite creates, so afterAll can remove it.
 *
 * These tests seed the LIVE Oracle on BASE_URL — a real learning file in the
 * real vault plus a real oracle_documents/oracle_fts row per POST. Until
 * 2026-07-27 nothing cleaned up, so 33 `yellow-*` artifacts had accumulated in
 * the production knowledge base across four test runs (2026-05-10, 05-15,
 * 06-10, 07-27), all with project=null, which means they leaked into every
 * project scope's search results.
 */
const created: Array<{ id?: string; file?: string }> = [];

async function seedLearn(pattern: string, concepts: string[] = []) {
  const res = await post("/api/learn", { pattern, source: SEED_TAG, concepts: [SEED_TAG, ...concepts] });
  if (!res.ok) throw new Error(`seed failed (${res.status}): ${await res.text()}`);
  const json = await res.json();
  created.push({ id: json?.id, file: json?.file });
  return json;
}

/**
 * Candidate roots the returned `file` paths could be relative to, best first.
 * No hardcoded host paths: /api/health reports repoRoot, and the vault root is
 * derived the same way the server derives it (settings.vault_repo -> ghq).
 */
async function candidateRoots(): Promise<string[]> {
  const out: string[] = [];
  try {
    const h = await (await fetch(`${BASE_URL}/api/health`)).json();
    if (typeof h?.repoRoot === "string" && h.repoRoot) out.push(h.repoRoot);
  } catch { /* older build has no repoRoot field */ }
  if (process.env.ORACLE_REPO_ROOT) out.push(process.env.ORACLE_REPO_ROOT);
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath(), { readonly: true });
    const repo = (db.prepare("SELECT value FROM settings WHERE key='vault_repo'").get() as { value?: string } | null)?.value;
    db.close();
    if (repo && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
      const p = Bun.spawnSync({ cmd: ["ghq", "list", "-p", repo] });
      const first = new TextDecoder().decode(p.stdout).trim().split("\n")[0]?.trim();
      if (first) out.push(first);
    }
  } catch { /* ghq unavailable or settings unreadable */ }
  if (process.env.HOME) out.push(path.join(process.env.HOME, ".arra-oracle-v2"));
  return out;
}

function dbPath(): string {
  return process.env.ORACLE_DB_PATH
    || path.join(process.env.HOME ?? "", ".arra-oracle-v2", "oracle.db");
}

/** Remove the files and rows this suite created. Never throws — cleanup is best-effort. */
async function cleanupSeeded(): Promise<{ removed: number; missed: string[] }> {
  const fs = await import("fs");
  const roots = await candidateRoots();
  let removed = 0;
  const missed: string[] = [];
  for (const c of created) {
    if (!c.file) continue;
    // The API returns a vault-relative path; try each candidate root until one hits.
    const hit = roots.map((r) => path.join(r, c.file!)).find((p) => fs.existsSync(p));
    if (hit) { try { fs.rmSync(hit, { force: true }); removed++; } catch { missed.push(c.file); } }
    else missed.push(c.file);
  }
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath());
    const ids = created.map((c) => c.id).filter((x): x is string => Boolean(x));
    for (const id of ids) {
      db.prepare("DELETE FROM oracle_documents WHERE id = ?").run(id);
      db.prepare("DELETE FROM oracle_fts WHERE id = ?").run(id);
    }
    // Anything tagged by this run that we did not capture an id for.
    db.prepare("DELETE FROM oracle_documents WHERE source_file LIKE ?").run(`%${SEED_TAG}%`);
    db.prepare("DELETE FROM learn_log WHERE source = ?").run(SEED_TAG);
    db.prepare("DELETE FROM supersede_log WHERE reason = ?").run("yellow http contract test");
    db.close();
  } catch { /* ignore — a failed cleanup must not fail the suite */ }
  return { removed, missed };
}

describe("HTTP Contract — search / knowledge / supersede", () => {
  beforeAll(async () => {
    if (await isUp()) return;
    serverProcess = Bun.spawn(["bun", "run", "src/server.ts"], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ORACLE_CHROMA_TIMEOUT: "3000" },
    });
    if (!(await waitUp())) throw new Error("Server failed to start within 15s");
  }, 30_000);
  afterAll(async () => {
    const { removed, missed } = await cleanupSeeded();
    // Loud, because a silent cleanup failure is how 33 artifacts accumulated.
    if (missed.length) {
      console.error(`[knowledge.test] cleanup MISSED ${missed.length} file(s) — remove by hand: ${missed.join(", ")}`);
    } else {
      console.error(`[knowledge.test] cleanup removed ${removed} seeded file(s)`);
    }
    if (serverProcess) serverProcess.kill();
  });

  describe("POST /api/learn", () => {
    test("creates a learning doc", async () => {
      const result = await seedLearn(`${SEED_TAG} — alpha about oracles`);
      expect(result).toBeDefined();
      expect(result.error).toBeUndefined();
    });

    test("seeds additional docs", async () => {
      await seedLearn(`${SEED_TAG} — beta on knowledge graphs`, ["graph"]);
      await seedLearn(`${SEED_TAG} — gamma mirrors reflect`, ["mirror"]);
    });

    test("rejects missing pattern field", async () => {
      const res = await post("/api/learn", { source: "test" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/pattern/i);
    });

    test("rejects malformed JSON body", async () => {
      const res = await fetch(`${BASE_URL}/api/learn`, { method: "POST", headers: JSON_HEADERS, body: "{not json" });
      expect(res.status).toBe(500);
    });
  });

  describe("GET /api/search", () => {
    test("finds seeded docs by unique tag", async () => {
      const res = await fetch(`${BASE_URL}/api/search?q=${encodeURIComponent(SEED_TAG)}`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(Array.isArray(data.results)).toBe(true);
      expect(data.query).toBe(SEED_TAG);
      expect(data.results.length).toBeGreaterThan(0);
    }, 30_000);

    test("respects limit parameter", async () => {
      const res = await fetch(`${BASE_URL}/api/search?q=pattern&limit=2`);
      expect(res.ok).toBe(true);
      expect((await res.json()).results.length).toBeLessThanOrEqual(2);
    }, 30_000);

    test("rejects missing query param", async () => {
      const res = await fetch(`${BASE_URL}/api/search`);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/q/);
    });

    test("rejects query empty after sanitize", async () => {
      const res = await fetch(`${BASE_URL}/api/search?q=${encodeURIComponent("<script></script>")}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/empty|invalid/i);
    });

    test("strips HTML tags from query", async () => {
      const res = await fetch(`${BASE_URL}/api/search?q=${encodeURIComponent(`<b>${SEED_TAG}</b>`)}`);
      expect(res.ok).toBe(true);
      expect((await res.json()).query).toBe(SEED_TAG);
    }, 30_000);
  });

  describe("GET /api/reflect", () => {
    test("returns content or error object", async () => {
      const res = await fetch(`${BASE_URL}/api/reflect`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.content !== undefined || data.error !== undefined).toBe(true);
    });
  });

  describe("GET /api/list", () => {
    test("returns documents array", async () => {
      const res = await fetch(`${BASE_URL}/api/list?limit=5`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(Array.isArray(data.results)).toBe(true);
      expect(data.results.length).toBeLessThanOrEqual(5);
    });

    test("accepts type filter", async () => {
      const res = await fetch(`${BASE_URL}/api/list?type=learning&limit=3`);
      expect(res.ok).toBe(true);
      expect(Array.isArray((await res.json()).results)).toBe(true);
    });
  });

  describe("GET /api/similar", () => {
    test("rejects missing id param", async () => {
      const res = await fetch(`${BASE_URL}/api/similar`);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/id/);
    });

    test("404-shaped payload for unknown id", async () => {
      const res = await fetch(`${BASE_URL}/api/similar?id=does-not-exist-${Date.now()}`);
      expect([200, 404]).toContain(res.status);
      expect(Array.isArray((await res.json()).results)).toBe(true);
    }, 15_000);
  });

  describe("GET /api/map, /api/map3d", () => {
    test("map returns documents shape", async () => {
      const data = await (await fetch(`${BASE_URL}/api/map`)).json();
      expect(data).toHaveProperty("documents");
      expect(typeof data.total === "number").toBe(true);
    }, 30_000);

    test("map3d returns documents shape", async () => {
      const data = await (await fetch(`${BASE_URL}/api/map3d`)).json();
      expect(data).toHaveProperty("documents");
    }, 30_000);
  });

  describe("POST /api/handoff + GET /api/inbox", () => {
    const slug = `yellow-test-${Date.now()}`;

    test("writes handoff file", async () => {
      const res = await post("/api/handoff", { content: `test handoff ${slug}`, slug });
      expect(res.status).toBe(201);
      const data = await res.json();
      created.push({ file: data?.file }); // so afterAll removes it from the real inbox
      expect(data.success).toBe(true);
      expect(data.file).toContain(slug);
    });

    test("rejects missing content field", async () => {
      const res = await post("/api/handoff", { slug: "x" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/content/i);
    });

    test("inbox lists handoffs including the one just written", async () => {
      const res = await fetch(`${BASE_URL}/api/inbox?type=handoff&limit=50`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(Array.isArray(data.files)).toBe(true);
      expect(typeof data.total).toBe("number");
      expect(data.files.some((f: { filename: string }) => f.filename.includes(slug))).toBe(true);
    });

    test("inbox honors pagination", async () => {
      const res = await fetch(`${BASE_URL}/api/inbox?limit=1&offset=0`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.files.length).toBeLessThanOrEqual(1);
      expect(data.limit).toBe(1);
      expect(data.offset).toBe(0);
    });
  });

  describe("Supersede", () => {
    const oldPath = `ψ/test/yellow-old-${Date.now()}.md`;
    const newPath = `ψ/test/yellow-new-${Date.now()}.md`;

    test("POST /api/supersede logs a supersession", async () => {
      const res = await post("/api/supersede", { old_path: oldPath, new_path: newPath, reason: "yellow http contract test" });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(typeof data.id === "number" || typeof data.id === "string").toBe(true);
    });

    test("POST /api/supersede rejects missing old_path", async () => {
      const res = await post("/api/supersede", { new_path: "x" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/old_path/);
    });

    test("GET /api/supersede returns contract shape", async () => {
      const res = await fetch(`${BASE_URL}/api/supersede?limit=5`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(Array.isArray(data.supersessions)).toBe(true);
      expect(typeof data.total).toBe("number");
      expect(data.limit).toBe(5);
      expect(data.offset).toBe(0);
    });

    test("GET /api/supersede/chain/:path empty for unknown path", async () => {
      const unknown = encodeURIComponent(`ψ/test/does-not-exist-${Date.now()}.md`);
      const res = await fetch(`${BASE_URL}/api/supersede/chain/${unknown}`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(Array.isArray(data.superseded_by)).toBe(true);
      expect(Array.isArray(data.supersedes)).toBe(true);
      expect(data.superseded_by.length).toBe(0);
      expect(data.supersedes.length).toBe(0);
    });
  });
});
