/**
 * Regression tests for resolveSourceFilesFromDb().
 *
 * Guards the fix for two defects found on 2026-07-27:
 *  - vector results took `source_file` from embed-time LanceDB metadata, so a
 *    rehomed document advertised its old path and arra_read({file}) 404'd;
 *  - the first fix built one IN-list for every id, which bun:sqlite rejects at
 *    scale ("expected 0 values, received 65536"). The caller's catch swallowed
 *    that, so ALL results silently reverted to stale metadata — a fail-open
 *    introduced while fixing a fail-silent.
 */

import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { resolveSourceFilesFromDb } from '../search.ts';

function makeDb(rows: Array<[string, string]>): Database {
  const db = new Database(':memory:');
  db.run('CREATE TABLE oracle_documents (id TEXT PRIMARY KEY, source_file TEXT)');
  const ins = db.prepare('INSERT INTO oracle_documents (id, source_file) VALUES (?, ?)');
  for (const [id, sf] of rows) ins.run(id, sf);
  return db;
}

describe('resolveSourceFilesFromDb', () => {
  it('returns an empty map for no ids without touching the DB', () => {
    const db = makeDb([]);
    expect(resolveSourceFilesFromDb(db, []).size).toBe(0);
    db.close();
  });

  it('returns the DB value, which is what makes the DB authoritative', () => {
    const db = makeDb([['learning_x', 'github.com/o/r/ψ/memory/learnings/x.md']]);
    const got = resolveSourceFilesFromDb(db, ['learning_x']);
    expect(got.get('learning_x')).toBe('github.com/o/r/ψ/memory/learnings/x.md');
    db.close();
  });

  it('omits ids that have no row, so the caller keeps its own provenance', () => {
    const db = makeDb([['present', 'a.md']]);
    const got = resolveSourceFilesFromDb(db, ['present', 'orphan-only-in-lancedb']);
    expect(got.has('present')).toBe(true);
    expect(got.has('orphan-only-in-lancedb')).toBe(false);
    expect(got.size).toBe(1);
    db.close();
  });

  it('binds ids as parameters — a SQL-metacharacter id cannot alter the query', () => {
    const nasty = `x'); DROP TABLE oracle_documents; --`;
    const db = makeDb([[nasty, 'safe.md']]);
    const got = resolveSourceFilesFromDb(db, [nasty]);
    expect(got.get(nasty)).toBe('safe.md');
    // table must still exist
    expect(db.prepare('SELECT COUNT(*) c FROM oracle_documents').get()).toEqual({ c: 1 });
    db.close();
  });

  it('chunks past the bind limit: 2000 ids resolve completely', () => {
    const rows: Array<[string, string]> = Array.from({ length: 2000 }, (_, i) => [`id_${i}`, `f_${i}.md`]);
    const db = makeDb(rows);
    const got = resolveSourceFilesFromDb(db, rows.map(([id]) => id));
    expect(got.size).toBe(2000);
    expect(got.get('id_0')).toBe('f_0.md');
    expect(got.get('id_1999')).toBe('f_1999.md');
    db.close();
  });

  it('issues one query per chunk — the structural proof that chunking happens', () => {
    const rows: Array<[string, string]> = Array.from({ length: 2000 }, (_, i) => [`id_${i}`, `f_${i}.md`]);
    const db = makeDb(rows);
    const ids = rows.map(([id]) => id);
    let queries = 0;
    const spy = { prepare: (sql: string) => { queries++; return db.prepare(sql); } };
    expect(resolveSourceFilesFromDb(spy, ids, 500).size).toBe(2000);
    expect(queries).toBe(4);
    queries = 0;
    expect(resolveSourceFilesFromDb(spy, ids, 2000).size).toBe(2000);
    expect(queries).toBe(1);
    db.close();
  });

  it('a single un-chunked query at the 2^16 bind boundary no longer throws — it degrades', () => {
    // SPEC CHANGE, deliberate (2026-07-27, second Codex audit): this used to be
    // asserted as `toThrow()`. Throwing was the fail-OPEN — the caller's outer
    // catch swallowed it and every result reverted to stale vector metadata. The
    // contract is now per-chunk isolation: a failing chunk is logged and skipped,
    // succeeding chunks are kept. The expectation moved because the requirement
    // moved, not to make a red test green.
    //
    // bun:sqlite rejects bind sets at exactly 2^16 — measured, not assumed:
    // 65535 binds fine, 65536 gives "expected 0 values, received 65536".
    const db = makeDb([]);
    const ids = Array.from({ length: 65_536 }, (_, i) => `id_${i}`);
    expect(() => resolveSourceFilesFromDb(db, ids, 1_000_000)).not.toThrow();
    expect(resolveSourceFilesFromDb(db, ids, 1_000_000).size).toBe(0); // degraded, not fatal
    expect(resolveSourceFilesFromDb(db, ids).size).toBe(0);            // chunked: also fine, table empty
    db.close();
  });

  it('isolates a failing chunk: earlier chunks survive it', () => {
    const rows: Array<[string, string]> = Array.from({ length: 10 }, (_, i) => [`id_${i}`, `f_${i}.md`]);
    const db = makeDb(rows);
    let calls = 0;
    const flaky = { prepare: (sql: string) => { calls++; if (calls === 2) throw new Error('simulated chunk-2 failure'); return db.prepare(sql); } };
    const got = resolveSourceFilesFromDb(flaky, rows.map(([id]) => id), 5);
    expect(got.size).toBe(5);              // chunk 1 kept
    expect(got.get('id_0')).toBe('f_0.md');
    expect(got.has('id_5')).toBe(false);   // chunk 2 lost, and only chunk 2
    db.close();
  });

  it('handles a batch that is an exact multiple of the chunk size', () => {
    const rows: Array<[string, string]> = Array.from({ length: 1000 }, (_, i) => [`e_${i}`, `e_${i}.md`]);
    const db = makeDb(rows);
    const got = resolveSourceFilesFromDb(db, rows.map(([id]) => id), 500);
    expect(got.size).toBe(1000);
    db.close();
  });
});
