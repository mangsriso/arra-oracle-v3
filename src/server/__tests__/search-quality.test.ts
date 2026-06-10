/**
 * Tests for search-quality helpers (Track D, plan 2026-06-10).
 * Shared by MCP (tools/search.ts) and HTTP (server/handlers.ts) paths.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { annotateAndFilterSuperseded, dedupChunks } from '../search-quality.ts';

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
