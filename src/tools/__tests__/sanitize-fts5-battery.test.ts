/**
 * Parse-safety + retrieval-quality gate for the unified FTS5 query sanitizer
 * (fix 2026-08-22, plan fable_FIX-PLAN-R2_sanitizer.md Part 1.2).
 *
 * In-memory bun:sqlite + the production initFts5() DDL (porter unicode61) —
 * the same pattern the committed ranking-eval harness already proved works
 * under bun (search-ranking-eval.test.ts). Written BEFORE the fix — this is
 * the RED gate. T1's 14 battery chars are the exact set that survived BOTH
 * legacy per-path deny-lists (probe1, plan Part 0.5) and crashed MATCH:
 * = , [ { $ # % ; & ! @ | < \
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initFts5 } from '../../db/index.ts';
import { sanitizeFtsQuery } from '../search.ts';

const BATTERY_CHARS = ['=', ',', '[', '{', '$', '#', '%', ';', '&', '!', '@', '|', '<', '\\'];

function matchThrows(db: Database, sanitized: string): Error | null {
  try {
    db.prepare('SELECT count(*) as c FROM oracle_fts WHERE oracle_fts MATCH ?').get(sanitized);
    return null;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

describe('sanitizeFtsQuery — parse-safety battery (RED gate, plan Part 1.2)', () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(':memory:');
    initFts5(db);
    const insFts = db.prepare(`INSERT INTO oracle_fts (id, content, concepts) VALUES (?, ?, '[]')`);
    insFts.run('SEED_THAI', 'ตรวจสอบ ก่อน push ตรวจสอบ config');
    insFts.run('SEED_EQ', 'EfficientIP check=1 DHCP overwrite gotcha destructive');
    insFts.run('SEED_SCATTER', 'check the config 1 time DHCP');
  });

  it('T1: 14 killer chars + NUL + operator keywords + mixed-punctuation query never crash MATCH', () => {
    const probes = [
      ...BATTERY_CHARS.map((c) => `p${c}2`),
      'a\x00b',
      'NOT this',
      'AND foo',
      "it's 15:30 v2.0.10 path/to/x",
    ];
    for (const q of probes) {
      const sanitized = sanitizeFtsQuery(q);
      if (sanitized === '') continue; // caller must SKIP the FTS leg — no MATCH call
      const err = matchThrows(db, sanitized);
      expect(err, `query ${JSON.stringify(q)} sanitized to ${JSON.stringify(sanitized)} threw: ${err?.message}`).toBeNull();
    }
  });

  it('T2: degenerate inputs return empty string, never the raw query', () => {
    for (const q of ['???', '***', '"""', '...', '"', '=', '   ']) {
      expect(sanitizeFtsQuery(q), `input ${JSON.stringify(q)}`).toBe('');
    }
  });

  it('T3: Thai positive control — proves T1 failures are query-content, not environment', () => {
    const sanitized = sanitizeFtsQuery('ตรวจสอบ ก่อน push');
    expect(sanitized).not.toBe('');
    expect(() => db.prepare('SELECT id FROM oracle_fts WHERE oracle_fts MATCH ?').all(sanitized)).not.toThrow();
    const rows = db.prepare('SELECT id FROM oracle_fts WHERE oracle_fts MATCH ? ORDER BY rank').all(sanitized) as Array<{ id: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.id === 'SEED_THAI')).toBe(true);

    const singleWord = sanitizeFtsQuery('ก่อน');
    expect(singleWord).not.toBe('');
    expect(() => db.prepare('SELECT id FROM oracle_fts WHERE oracle_fts MATCH ?').all(singleWord)).not.toThrow();
  });

  it('T4: retrieval-quality pin for check=1 — SEED_EQ is found and ranks above SEED_SCATTER', () => {
    const sanitized = sanitizeFtsQuery('check=1');
    expect(sanitized).not.toBe('');
    const rows = db.prepare('SELECT id FROM oracle_fts WHERE oracle_fts MATCH ? ORDER BY rank').all(sanitized) as Array<{ id: string }>;
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('SEED_EQ');
    const eqIdx = ids.indexOf('SEED_EQ');
    const scatterIdx = ids.indexOf('SEED_SCATTER');
    // SEED_SCATTER has 'check' and '1' non-adjacent — a phrase-quoted query
    // must not match it at all (adjacency required); if it somehow does
    // match, SEED_EQ (adjacent) must still rank strictly above it.
    if (scatterIdx !== -1) {
      expect(eqIdx).toBeLessThan(scatterIdx);
    }
  });
});
