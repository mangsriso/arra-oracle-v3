/**
 * Unit tests for search helpers (pure functions).
 * These were previously duplicated in oracle-core.test.ts.
 */

import { describe, it, expect } from 'bun:test';
import {
  sanitizeFtsQuery,
  normalizeFtsScore,
  parseConceptsFromMetadata,
  combineResults,
} from '../search.ts';

// ============================================================================
// sanitizeFtsQuery
// ============================================================================

describe('sanitizeFtsQuery', () => {
  it('quotes every token as a phrase (implicit AND)', () => {
    expect(sanitizeFtsQuery('force push safety')).toBe('"force" "push" "safety"');
    expect(sanitizeFtsQuery('oracle philosophy')).toBe('"oracle" "philosophy"');
  });
  it('preserves special-character tokens as searchable phrases (the check=1 class)', () => {
    expect(sanitizeFtsQuery('check=1')).toBe('"check=1"');
    expect(sanitizeFtsQuery('v2.0.10')).toBe('"v2.0.10"');
    expect(sanitizeFtsQuery('192.168.1.1')).toBe('"192.168.1.1"');
    expect(sanitizeFtsQuery('path/to/file')).toBe('"path/to/file"');
    expect(sanitizeFtsQuery('error: no such column')).toBe('"error:" "no" "such" "column"');
  });
  it('doubles internal double-quotes (the only FTS5-special char inside a string)', () => {
    expect(sanitizeFtsQuery('say "hi"')).toBe('"say" """hi"""');
  });
  it('neutralizes FTS5 operator keywords (leading NOT crashed MATCH under pass-through)', () => {
    expect(sanitizeFtsQuery('NOT this')).toBe('"NOT" "this"');
    expect(sanitizeFtsQuery('foo OR bar')).toBe('"foo" "OR" "bar"');
  });
  it('preserves Thai verbatim, including combining marks (U+0E48 is \\p{M})', () => {
    expect(sanitizeFtsQuery('ตรวจสอบ ก่อน push')).toBe('"ตรวจสอบ" "ก่อน" "push"');
  });
  it('normalizes whitespace', () => {
    expect(sanitizeFtsQuery('  hello   world  ')).toBe('"hello" "world"');
  });
  it('drops tokens with no letter or digit', () => {
    expect(sanitizeFtsQuery('-- force')).toBe('"force"');
    expect(sanitizeFtsQuery('🔥 fire')).toBe('"fire"');
  });
  it('returns empty string for degenerate input — NEVER the raw query', () => {
    for (const q of ['???', '***', '"""', '...', '"', '=']) expect(sanitizeFtsQuery(q)).toBe('');
  });
  it('strips control characters (NUL breaks even a quoted FTS5 string)', () => {
    expect(sanitizeFtsQuery('a\x00b c')).toBe('"a" "b" "c"');
  });
});

// ============================================================================
// normalizeFtsScore
// ============================================================================

describe('normalizeFtsScore', () => {
  it('should return values between 0 and 1', () => {
    for (let i = -100; i <= 0; i++) {
      const score = normalizeFtsScore(i);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('should give better scores for better ranks (more negative bm25 = better match)', () => {
    expect(normalizeFtsScore(-5)).toBeGreaterThan(normalizeFtsScore(-1));
    expect(normalizeFtsScore(-10)).toBeGreaterThan(normalizeFtsScore(-5));
  });

  it('pins the corrected direction and bounds (regression guard for the 2026-01→08 inversion)', () => {
    // Live smoking-gun pair: bm25 -27.96 (exact-topic doc) must outscore -16.88 (tangential doc).
    expect(normalizeFtsScore(-27.96)).toBeGreaterThan(normalizeFtsScore(-16.88));
    // Strict monotonicity across the whole observed range.
    let prev = normalizeFtsScore(0);
    for (let r = -0.5; r >= -50; r -= 0.5) {
      const s = normalizeFtsScore(r);
      expect(s).toBeGreaterThan(prev);
      prev = s;
    }
    // Zero-signal rank scores zero, not perfect.
    expect(normalizeFtsScore(0)).toBe(0);
  });
});

// ============================================================================
// parseConceptsFromMetadata
// ============================================================================

describe('parseConceptsFromMetadata', () => {
  it('should handle null/undefined', () => {
    expect(parseConceptsFromMetadata(null)).toEqual([]);
    expect(parseConceptsFromMetadata(undefined)).toEqual([]);
  });

  it('should handle arrays', () => {
    expect(parseConceptsFromMetadata(['trust', 'safety'])).toEqual(['trust', 'safety']);
  });

  it('should parse JSON strings', () => {
    expect(parseConceptsFromMetadata('["trust","safety"]')).toEqual(['trust', 'safety']);
  });

  it('should split comma-separated strings (LanceDB metadata format)', () => {
    expect(parseConceptsFromMetadata('not json')).toEqual(['not json']);
    expect(parseConceptsFromMetadata('pattern,decision,oracle')).toEqual(['pattern', 'decision', 'oracle']);
    expect(parseConceptsFromMetadata('')).toEqual([]);
  });
});

// ============================================================================
// combineResults
// ============================================================================

describe('combineResults', () => {
  const ftsResults = [
    { id: 'doc1', type: 'principle', content: 'Content 1', source_file: 'f1.md', concepts: ['trust'], score: 0.8, source: 'fts' as const },
    { id: 'doc2', type: 'learning', content: 'Content 2', source_file: 'f2.md', concepts: ['pattern'], score: 0.6, source: 'fts' as const },
  ];

  const vectorResults = [
    { id: 'doc1', type: 'principle', content: 'Content 1', source_file: 'f1.md', concepts: ['trust'], score: 0.9, source: 'vector' as const },
    { id: 'doc3', type: 'retro', content: 'Content 3', source_file: 'f3.md', concepts: ['decision'], score: 0.7, source: 'vector' as const },
  ];

  it('should mark duplicates as hybrid', () => {
    const combined = combineResults(ftsResults, vectorResults);
    const doc1 = combined.find(r => r.id === 'doc1');
    expect(doc1?.source).toBe('hybrid');
    expect(doc1?.ftsScore).toBe(0.8);
    expect(doc1?.vectorScore).toBe(0.9);
  });

  it('should keep FTS-only as fts source', () => {
    const combined = combineResults(ftsResults, vectorResults);
    expect(combined.find(r => r.id === 'doc2')?.source).toBe('fts');
  });

  it('should keep vector-only as vector source', () => {
    const combined = combineResults(ftsResults, vectorResults);
    expect(combined.find(r => r.id === 'doc3')?.source).toBe('vector');
  });

  it('should apply 10% boost for hybrid results', () => {
    const combined = combineResults(ftsResults, vectorResults, 0.5, 0.5);
    const doc1 = combined.find(r => r.id === 'doc1');
    // ((0.5 * 0.8) + (0.5 * 0.9)) * 1.1 = 0.935
    expect(doc1?.score).toBeCloseTo(0.935, 2);
  });

  it('caps the hybrid score at 1.0 (regression guard — see handlers.ts twin)', () => {
    // Reachable since the 2026-08-22 normalizer fix: an exact-phrase FTS hit
    // (bm25 -248 -> 0.9960) plus a close vector hit (distance 0.1275 -> 0.8725)
    // gives ((0.5*0.9960)+(0.5*0.8725))*1.1 = 1.0277 without the cap.
    const fts = [{ id: 'd', type: 'learning', content: 'c', source_file: 'f.md', concepts: [], score: 0.9960, source: 'fts' as const }];
    const vec = [{ id: 'd', type: 'learning', content: 'c', source_file: 'f.md', concepts: [], score: 0.8725, source: 'vector' as const }];
    const doc = combineResults(fts, vec, 0.5, 0.5).find(r => r.id === 'd');
    expect(doc?.source).toBe('hybrid');
    expect(doc?.score).toBe(1);
    expect(doc?.score).toBeLessThanOrEqual(1);
  });

  it('should sort by score descending', () => {
    const combined = combineResults(ftsResults, vectorResults);
    for (let i = 1; i < combined.length; i++) {
      expect(combined[i - 1].score).toBeGreaterThanOrEqual(combined[i].score);
    }
  });

  it('should handle empty inputs', () => {
    expect(combineResults([], [])).toEqual([]);
    expect(combineResults(ftsResults, [])).toHaveLength(2);
    expect(combineResults([], vectorResults)).toHaveLength(2);
  });
});
