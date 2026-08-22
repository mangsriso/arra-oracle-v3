/**
 * F5 gate — the MCP twin of 12a2124. vectorSearch mapped the wire distance
 * with `|| 0` and handleSearch inverted it with `1 - (score || 0)`, so a
 * vector hit whose adapter returned no distance (short/holed array, null,
 * NaN) scored a PERFECT 1.0 and outranked every measured hit on arra_search.
 *
 * The fix keeps this twin's own scale (1 - d): measured distances score
 * bit-identically before and after; only unmeasured hits move — sentinel
 * distance 2 (worst measurable) → similarity -1 → they sort LAST.
 *
 * Drives the REAL MCP vector leg via a ctx.vectorStore stub — the
 * search-fts-fallback.test.ts pattern: env rail untouched (test-safety still
 * asserts ORACLE_DISABLE_LOCAL_VECTOR=true), the compiled const is mocked
 * for this file's process only (bunfig [test].isolate=true), LanceDB native
 * code is never loaded.
 *
 * Falsification (recorded 2026-08-23): on pre-fix code T1/T2/T4 go RED —
 * the no-distance hit scores 0.5 and ranks 1 in both vector and hybrid mode.
 */
import { describe, it, expect, mock } from 'bun:test';
import { Database } from 'bun:sqlite';

const CONFIG = '../../config.ts';
const actualConfig = await import(CONFIG);
mock.module(CONFIG, () => ({ ...actualConfig, DISABLE_LOCAL_VECTOR: false }));

const { initFts5 } = await import('../../db/index.ts');
const { handleSearch } = await import('../search.ts');

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
  for (const [id, sf] of [
    ['VDOC_NEAR', 'fixture/near.md'], ['VDOC_FAR', 'fixture/far.md'],
    ['VDOC_GHOST', 'fixture/ghost.md'], ['VDOC_NAN', 'fixture/nan.md'],
    ['VDOC_ZERO', 'fixture/zero.md'], ['FTS_DOC1', 'fixture/fts-doc1.md'],
  ]) insDoc.run(id, sf);
  db.prepare(`INSERT INTO oracle_fts (id, content, concepts) VALUES (?, ?, '[]')`)
    .run('FTS_DOC1', 'EfficientIP gotcha destructive overwrite config check');
  return db;
}

function makeStore(ids: string[], distances: number[]) {
  return {
    query: async () => ({
      ids,
      documents: ids.map((id) => `content of ${id}`),
      distances,
      metadatas: ids.map((id) => ({ type: 'learning', source_file: `fixture/${id.toLowerCase()}.md`, concepts: '[]' })),
    }),
  };
}

import type { ToolContext } from '../types.ts';
function makeCtx(sqlite: Database, vectorStore: unknown): ToolContext {
  return {
    db: null as unknown as ToolContext['db'],
    sqlite,
    repoRoot: '/fake/sentinel-fixture',
    vectorStore: vectorStore as ToolContext['vectorStore'],
    vectorStatus: 'available',
    version: 'sentinel-test',
    telemetryEnabled: false,
  } as ToolContext;
}

const db = makeFixtureDb();
type ParsedResult = { id: string; score: number };
const parse = (resp: { content: Array<{ text: string }> }): { results: ParsedResult[] } =>
  JSON.parse(resp.content[0]!.text);

describe('MCP vector distance sentinel (the 12a2124 defect on this twin)', () => {
  it('T1: a hit with NO distance (holed array) scores as worst, never a perfect 1.0', async () => {
    const ctx = makeCtx(db, makeStore(['VDOC_NEAR', 'VDOC_FAR', 'VDOC_GHOST'], [0.26, 0.61]));
    const parsed = parse(await handleSearch(ctx, { query: 'anything', mode: 'vector', limit: 10 }));
    const byId = new Map(parsed.results.map((r) => [r.id, r]));
    const near = byId.get('VDOC_NEAR')!, far = byId.get('VDOC_FAR')!, ghost = byId.get('VDOC_GHOST')!;
    // measured hits keep the existing 1 - d scale, x0.5 vector weight — no ranking change
    expect(near.score).toBeCloseTo(0.37, 5);   // (1 - 0.26) * 0.5
    expect(far.score).toBeCloseTo(0.195, 5);   // (1 - 0.61) * 0.5
    // pre-fix: ghost = (1 - (undefined || 0)) * 0.5 = 0.5 → rank 1 above every measured hit
    expect(ghost.score).toBeCloseTo(-0.5, 5);  // (1 - 2) * 0.5 — sentinel 2 = worst
    expect(parsed.results[0]!.id).toBe('VDOC_NEAR');
    expect(parsed.results[parsed.results.length - 1]!.id).toBe('VDOC_GHOST');
  });

  it('T2: a NaN distance scores as worst, never a perfect 1.0', async () => {
    const ctx = makeCtx(db, makeStore(['VDOC_NEAR', 'VDOC_NAN'], [0.26, NaN]));
    const parsed = parse(await handleSearch(ctx, { query: 'anything', mode: 'vector', limit: 10 }));
    const nan = parsed.results.find((r) => r.id === 'VDOC_NAN')!;
    expect(nan.score).toBeCloseTo(-0.5, 5);
    expect(parsed.results[0]!.id).toBe('VDOC_NEAR');
  });

  it('T3: control — a GENUINE distance of 0 (exact duplicate) keeps the perfect score', async () => {
    const ctx = makeCtx(db, makeStore(['VDOC_ZERO'], [0]));
    const parsed = parse(await handleSearch(ctx, { query: 'anything', mode: 'vector', limit: 10 }));
    expect(parsed.results[0]!.id).toBe('VDOC_ZERO');
    expect(parsed.results[0]!.score).toBeCloseTo(0.5, 5); // (1 - 0) * 0.5 — must NOT be swallowed
  });

  it('T4: hybrid — a no-distance vector hit must not outrank a real FTS match', async () => {
    const ctx = makeCtx(db, makeStore(['VDOC_GHOST'], []));
    const parsed = parse(await handleSearch(ctx, { query: 'EfficientIP gotcha overwrite', mode: 'hybrid', limit: 10 }));
    const fts = parsed.results.find((r) => r.id === 'FTS_DOC1')!;
    const ghost = parsed.results.find((r) => r.id === 'VDOC_GHOST')!;
    expect(fts).toBeDefined();
    expect(ghost).toBeDefined();
    expect(parsed.results[0]!.id).toBe('FTS_DOC1');       // pre-fix: VDOC_GHOST at 0.5 wins
    expect(ghost.score).toBeLessThan(fts.score);
  });
});
