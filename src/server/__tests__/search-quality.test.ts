/**
 * Tests for search-quality helpers (Track D, plan 2026-06-10).
 * Shared by MCP (tools/search.ts) and HTTP (server/handlers.ts) paths.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { annotateAndFilterSuperseded, dedupChunks, normalizeBm25Rank, normalizeVectorDistance, sanitizeFtsQuery } from '../search-quality.ts';
import { sanitizeFtsQuery as sanitizeFtsQueryFromToolsTwin } from '../../tools/search.ts';

function makeDb(rows: Array<{ id: string; project?: string | null; superseded_by?: string | null }>) {
  const db = new Database(':memory:');
  db.run('CREATE TABLE oracle_documents (id TEXT PRIMARY KEY, project TEXT, superseded_by TEXT)');
  const ins = db.prepare('INSERT INTO oracle_documents (id, project, superseded_by) VALUES (?, ?, ?)');
  for (const r of rows) ins.run(r.id, r.project ?? null, r.superseded_by ?? null);
  return db;
}

describe('annotateAndFilterSuperseded', () => {
  const db = makeDb([
    { id: 'a', project: 'github.com/x/y' },
    { id: 'b', project: null, superseded_by: '_verified_orphan' },
    { id: 'c', project: 'github.com/x/y', superseded_by: 'learning_new' },
  ]);

  test('hides superseded docs by default and counts pool-scoped', () => {
    const { results, hidden } = annotateAndFilterSuperseded(
      db,
      [{ id: 'a', source_file: 'f1' }, { id: 'b', source_file: 'f2' }, { id: 'c', source_file: 'f3' }],
      false,
    );
    expect(results.map(r => r.id)).toEqual(['a']);
    expect(hidden).toBe(2);
  });

  test('include_superseded=true returns everything (Nothing is Deleted)', () => {
    const { results, hidden } = annotateAndFilterSuperseded(
      db,
      [{ id: 'a', source_file: 'f1' }, { id: 'b', source_file: 'f2' }, { id: 'c', source_file: 'f3' }],
      true,
    );
    expect(results.map(r => r.id)).toEqual(['a', 'b', 'c']);
    expect(hidden).toBe(0);
  });

  test('kept superseded docs are FLAGGED so both paths can tell (HTTP has no enrichment)', () => {
    const { results } = annotateAndFilterSuperseded(
      db,
      [{ id: 'a', source_file: 'f1' }, { id: 'b', source_file: 'f2' }, { id: 'c', source_file: 'f3' }],
      true,
    );
    expect(results.find(r => r.id === 'a')?.superseded_by).toBeUndefined();
    expect(results.find(r => r.id === 'b')?.superseded_by).toBe('_verified_orphan');
    expect(results.find(r => r.id === 'c')?.superseded_by).toBe('learning_new');
  });

  test('annotates project from DB without overwriting an existing value', () => {
    const { results } = annotateAndFilterSuperseded(
      db,
      [
        { id: 'a', source_file: 'f1' },
        { id: 'c', source_file: 'f3', project: 'preset' },
      ],
      true,
    );
    expect(results[0].project).toBe('github.com/x/y');
    expect(results[1].project).toBe('preset');
  });

  test('unknown ids pass through with project=null', () => {
    const { results, hidden } = annotateAndFilterSuperseded(
      db, [{ id: 'zz', source_file: 'f' }], false,
    );
    expect(results).toHaveLength(1);
    expect(results[0].project).toBeNull();
    expect(hidden).toBe(0);
  });

  test('empty input is a no-op', () => {
    const { results, hidden } = annotateAndFilterSuperseded(db, [], false);
    expect(results).toEqual([]);
    expect(hidden).toBe(0);
  });
});

describe('normalizeVectorDistance', () => {
  test('is strictly decreasing in distance (nearer = better) and stays in [0,1]', () => {
    expect(normalizeVectorDistance(0)).toBe(1);
    expect(normalizeVectorDistance(0.25)).toBeGreaterThan(normalizeVectorDistance(0.5));
    expect(normalizeVectorDistance(0.5)).toBeGreaterThan(normalizeVectorDistance(1));
    expect(normalizeVectorDistance(2)).toBe(0);
    for (const d of [0, 0.25, 0.43, 0.61, 1, 1.5, 2]) {
      const s = normalizeVectorDistance(d);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  test('clamps distances outside the dot-distance domain instead of leaving [0,1]', () => {
    // Anti-correlated embeddings (d > 2) and any adapter reporting a negative
    // distance must not break the documented 0-1 score contract.
    expect(normalizeVectorDistance(2.4)).toBe(0);
    expect(normalizeVectorDistance(-0.3)).toBe(1);
  });

  // Regression guard for the 2026-08-22 defect. The HTTP path used
  // `1 / (1 + distance / 100)`, which mapped the whole measured range of real
  // top-N dot-distances (~[0.26, 0.61]) into [0.9940, 0.9974]. Because
  // handleSearch merges the two legs with max(fts, vector), that band beat
  // EVERY bm25-normalized FTS score, so an exact single-document token match
  // sank to rank 157/157 and vanished entirely at the default limit=10.
  // These assertions compare the two shared normalizers against each other —
  // the scale relationship IS the defect. Both fail under the old formula.
  test('the vector band no longer swamps the bm25 band', () => {
    const bestRealisticVector = normalizeVectorDistance(0.26);
    const decentExactFtsMatch = normalizeBm25Rank(-20);
    expect(bestRealisticVector).toBeLessThan(decentExactFtsMatch);
  });

  test('spreads the measured distance range instead of compressing it near 1.0', () => {
    const spread = normalizeVectorDistance(0.26) - normalizeVectorDistance(0.61);
    expect(spread).toBeGreaterThan(0.1); // old formula produced 0.0034
  });
});

describe('normalizeBm25Rank', () => {
  test('is strictly increasing in match quality (more negative bm25 = better) and stays in [0,1)', () => {
    expect(normalizeBm25Rank(-28)).toBeGreaterThan(normalizeBm25Rank(-17));
    expect(normalizeBm25Rank(-17)).toBeGreaterThan(normalizeBm25Rank(-5));
    expect(normalizeBm25Rank(-5)).toBeGreaterThan(normalizeBm25Rank(-1));
    expect(normalizeBm25Rank(-1)).toBeGreaterThan(normalizeBm25Rank(0));
    expect(normalizeBm25Rank(0)).toBe(0);
    for (const r of [0, -1, -5, -17, -28, -100]) {
      const s = normalizeBm25Rank(r);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(1);
    }
  });
});

describe('sanitizeFtsQuery', () => {
  test('quotes every token as a phrase (implicit AND)', () => {
    expect(sanitizeFtsQuery('force push safety')).toBe('"force" "push" "safety"');
  });

  test('doubles internal double-quotes', () => {
    expect(sanitizeFtsQuery('say "hi"')).toBe('"say" """hi"""');
  });

  test('returns empty string for degenerate input — never the raw query', () => {
    for (const q of ['???', '***', '"""', '...', '"', '=']) expect(sanitizeFtsQuery(q)).toBe('');
  });

  test('twin-parity: src/tools/search.ts sanitizeFtsQuery delegate stays byte-identical to the shared source', () => {
    const queries = [
      'force push safety',
      'check=1',
      'NOT this',
      'ตรวจสอบ ก่อน push',
      'v2.0.10',
      'say "hi"',
      '???',
      '  hello   world  ',
      'path/to/file',
      'error: no such column',
    ];
    for (const q of queries) {
      expect(sanitizeFtsQueryFromToolsTwin(q), `query ${JSON.stringify(q)}`).toBe(sanitizeFtsQuery(q));
    }
  });
});

describe('dedupChunks', () => {
  test('keeps first occurrence per (project, source_file) — positional, not score', () => {
    const { results, removed } = dedupChunks([
      { id: 'doc_1_0', source_file: 'file.md', project: 'p1' },
      { id: 'doc_2_0', source_file: 'other.md', project: 'p1' },
      { id: 'doc_1_3', source_file: 'file.md', project: 'p1' },
      { id: 'doc_1_7', source_file: 'file.md', project: 'p1' },
    ]);
    expect(results.map(r => r.id)).toEqual(['doc_1_0', 'doc_2_0']);
    expect(removed).toBe(2);
    expect(results[0].chunk_count).toBe(3);
    expect(results[1].chunk_count).toBeUndefined();
  });

  test('same source_file in different projects does NOT collapse', () => {
    const { results, removed } = dedupChunks([
      { id: 'a', source_file: 'src/logger.ts', project: 'github.com/x/one' },
      { id: 'b', source_file: 'src/logger.ts', project: 'github.com/x/two' },
      { id: 'c', source_file: 'src/logger.ts', project: null },
    ]);
    expect(results).toHaveLength(3);
    expect(removed).toBe(0);
  });

  test('preserves ranked order of survivors', () => {
    const { results } = dedupChunks([
      { id: '1', source_file: 'b.md', project: null },
      { id: '2', source_file: 'a.md', project: null },
      { id: '3', source_file: 'b.md', project: null },
      { id: '4', source_file: 'c.md', project: null },
    ]);
    expect(results.map(r => r.id)).toEqual(['1', '2', '4']);
  });
});
