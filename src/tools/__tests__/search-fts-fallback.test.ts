/**
 * DEFECT 2 gate — hybrid/FTS search must survive an FTS5 runtime failure by
 * degrading to vector-only (hybrid) or empty-with-warning (fts), never an
 * unhandled throw. The fault is injected DETERMINISTICALLY via a proxy over
 * ctx.sqlite.prepare() that throws only for SQL containing 'oracle_fts
 * MATCH' — independent of query content, so after the sanitizer fix (which
 * makes a query-triggered FTS5 parse error effectively impossible) this
 * test remains the only thing pinning the catch/fallback path.
 * Plan: fable_FIX-PLAN-R2_sanitizer.md Part 1.3.
 *
 * telemetryEnabled: false on every ctx — writeToolTelemetry (../telemetry.ts)
 * short-circuits before calling logSearch, so this file never touches the
 * live search_log even though it imports the real handleSearch.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initFts5 } from '../../db/index.ts';
import { handleSearch } from '../search.ts';
import type { ToolContext } from '../types.ts';

// DEVIATION FROM PLAN (recorded in the impl report): tests/preload.ts
// (bunfig.toml global preload) forces ORACLE_DISABLE_LOCAL_VECTOR=true for
// EVERY bun test run, and src/config.ts itself hard-throws
// ("[test-safety] ORACLE_DISABLE_LOCAL_VECTOR=true is required in strict
// test mode", src/testing/test-safety.ts:77) if that invariant doesn't
// hold — a deliberate repo safety rail (the real LanceDB path SIGILLs on
// AVX-only CPUs), not something to route around. Consequence: in this
// harness the hybrid vector leg in search.ts is ALWAYS gated off before
// ctx.vectorStore.query() is ever reached, so T5 cannot observe "vector-only
// results returned" as the original plan (Part 1.3) intended — it can only
// observe "hybrid mode does not throw when FTS fails, and both the FTS and
// vector-disabled warnings compose", which is what T5 asserts below.
// vectorStore stays null (search-ranking-eval.test.ts convention) since it
// is provably unreachable here.

const FTS_ERROR_MESSAGE = 'fts5: syntax error near "="';

function makeFixtureDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE oracle_documents (
      id TEXT PRIMARY KEY, type TEXT, source_file TEXT, concepts TEXT,
      project TEXT, superseded_by TEXT, superseded_at INTEGER, superseded_reason TEXT
    );
  `);
  initFts5(db);
  const insDoc = db.prepare(`INSERT INTO oracle_documents (id, type, source_file, concepts) VALUES (?, 'learning', ?, '[]')`);
  const insFts = db.prepare(`INSERT INTO oracle_fts (id, content, concepts) VALUES (?, ?, '[]')`);
  insDoc.run('FTS_DOC1', 'fixture/fts-doc1.md');
  insFts.run('FTS_DOC1', 'EfficientIP gotcha destructive overwrite config check');
  insDoc.run('VEC_DOC1', 'fixture/vec-doc1.md');
  insDoc.run('VEC_DOC2', 'fixture/vec-doc2.md');
  return db;
}

/**
 * Wraps a real bun:sqlite Database so any prepare() of a SQL string
 * containing 'oracle_fts MATCH' returns a statement that throws on
 * all()/get()/run() — every other SQL passes through untouched to the real
 * fixture db (superseded-pass lookups, resolveSourceFilesFromDb, etc.).
 */
function makeFaultInjectingSqlite(real: Database): Database {
  const throwing = {
    all: () => { throw new Error(FTS_ERROR_MESSAGE); },
    get: () => { throw new Error(FTS_ERROR_MESSAGE); },
    run: () => { throw new Error(FTS_ERROR_MESSAGE); },
    values: () => { throw new Error(FTS_ERROR_MESSAGE); },
  };
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string, ...rest: unknown[]) => {
          if (typeof sql === 'string' && sql.includes('oracle_fts MATCH')) {
            return throwing;
          }
          return (target.prepare as (...a: unknown[]) => unknown)(sql, ...rest);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as Database;
}

function makeCtx(sqlite: Database): ToolContext {
  return {
    db: null as unknown as ToolContext['db'],
    sqlite,
    repoRoot: '/fake/fallback-fixture',
    // Unreachable in this harness — see the DEVIATION note above
    // (ORACLE_DISABLE_LOCAL_VECTOR is forced true, gating the vector leg
    // off before ctx.vectorStore.query() would ever be called).
    vectorStore: null as unknown as ToolContext['vectorStore'],
    vectorStatus: 'unavailable',
    version: 'fallback-test',
    telemetryEnabled: false,
  };
}

describe('search FTS-fault fallback (DEFECT 2 gate, plan Part 1.3)', () => {
  let realDb: Database;

  beforeAll(() => {
    // reranker.test.ts:27's afterEach only restores this var when it was
    // truthy BEFORE that file ran — pre-existing cross-file env pollution
    // documented in search-ranking-eval.test.ts; clear defensively here too.
    delete process.env.ORACLE_RERANKER_URL;
    realDb = makeFixtureDb();
  });

  it('T5: mode=hybrid + injected FTS fault resolves (no throw) with composed FTS+vector warnings and ftsError metadata', async () => {
    const ctx = makeCtx(makeFaultInjectingSqlite(realDb));
    const resp = await handleSearch(ctx, { query: 'EfficientIP check overwrite', mode: 'hybrid', limit: 10 });
    const parsed = JSON.parse(resp.content[0]!.text);
    // Vector leg is also unavailable in this harness (see DEVIATION note),
    // so results are empty here — the property under test is that hybrid
    // mode resolves at all (no throw) and both warnings compose (§2.2d).
    expect(parsed.results).toEqual([]);
    expect(parsed.metadata.warning).toMatch(/FTS5 query failed/);
    expect(parsed.metadata.warning).toMatch(/Local vector adapter disabled/);
    expect(parsed.metadata.ftsError).toBe(true);
    expect(parsed.metadata.ftsMatches).toBe(0);
  });

  it('T6: mode=fts + injected FTS fault resolves to empty results with warning, no throw', async () => {
    const ctx = makeCtx(makeFaultInjectingSqlite(realDb));
    const resp = await handleSearch(ctx, { query: 'EfficientIP check overwrite', mode: 'fts', limit: 10 });
    const parsed = JSON.parse(resp.content[0]!.text);
    expect(parsed.results).toEqual([]);
    expect(parsed.metadata.warning).toMatch(/FTS5 query failed/);
  });

  it('T7: positive control — same ctx minus the fault proxy, mode=fts finds real FTS results', async () => {
    const ctx = makeCtx(realDb);
    const resp = await handleSearch(ctx, { query: 'EfficientIP check overwrite', mode: 'fts', limit: 10 });
    const parsed = JSON.parse(resp.content[0]!.text);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results.some((r: { id: string }) => r.id === 'FTS_DOC1')).toBe(true);
  });
});
