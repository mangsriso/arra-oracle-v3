/**
 * Search quality helpers shared by BOTH search implementations
 * (MCP: src/tools/search.ts, HTTP: src/server/handlers.ts).
 *
 * Contract (plan 2026-06-10 Track D): both paths apply the SAME dedup key and
 * SAME survivor rule. Scoring stays per-path (the two combine functions use
 * different algorithms by design) — except bm25-rank normalization, shared
 * via normalizeBm25Rank since 2026-08 — and, since 2026-08-22, FTS5 query
 * sanitization via sanitizeFtsQuery (the deny-list era had two divergent
 * per-path copies, both leaky).
 */

import type { Database } from 'bun:sqlite';

/**
 * Normalize an SQLite FTS5 bm25 `rank` to a 0–1 score, higher = better.
 * FTS5 rank is NEGATIVE and MORE-negative = BETTER match; this map is
 * strictly increasing in |rank|. Shared by both search twins
 * (src/tools/search.ts normalizeFtsScore, src/server/handlers.ts
 * normalizeRank) — the 2026-01→08 inversion bug lived in two divergent
 * per-path copies; keep ONE definition.
 */
export function normalizeBm25Rank(rank: number): number {
  const absRank = Math.abs(rank);
  return absRank / (1 + absRank);
}

/**
 * Sanitize arbitrary user/agent text into a query string that FTS5 MATCH is
 * guaranteed to parse: every whitespace-delimited token becomes a quoted
 * phrase ("…"), internal double-quotes doubled, control chars stripped
 * (NUL breaks even a quoted string), tokens with no letter/digit dropped
 * (they tokenize to nothing). Returns '' when nothing searchable remains —
 * callers must then SKIP the FTS leg (never send the raw query; the
 * 2026-01→08 deny-list era let 14 characters through per path and the MCP
 * empty-branch returned the raw query, both killing the whole search).
 *
 * Semantics: quoted tokens are literal phrases — FTS5 operators
 * (AND/OR/NOT/NEAR), column filters (col:term) and prefix (tok*) are
 * deliberately neutralized. Porter stemming still applies inside phrases.
 * Shared by both search twins (src/tools/search.ts sanitizeFtsQuery
 * delegate, src/server/handlers.ts handleSearch) — keep ONE definition.
 */
export function sanitizeFtsQuery(query: string): string {
  return query
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .split(/\s+/)
    .filter((token) => /[\p{L}\p{N}]/u.test(token))
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(' ');
}

export interface QualityCandidate {
  id: string;
  source_file: string;
  project?: string | null;
  chunk_count?: number;
  superseded_by?: string;
}

/**
 * Batch-annotate candidates with `project` (needed for the dedup key) and,
 * unless `includeSuperseded`, drop documents whose `superseded_by` is set.
 *
 * `hidden` counts documents removed from THIS candidate pool (not corpus-wide).
 * Superseded docs remain reachable with include_superseded=true — hiding by
 * default does not delete anything (P-001 "Nothing is Deleted").
 */
export function annotateAndFilterSuperseded<T extends QualityCandidate>(
  sqlite: Database,
  candidates: T[],
  includeSuperseded: boolean,
): { results: T[]; hidden: number } {
  if (candidates.length === 0) return { results: candidates, hidden: 0 };

  const ids = candidates.map((c) => c.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = sqlite.prepare(`
    SELECT id, project, superseded_by
    FROM oracle_documents
    WHERE id IN (${placeholders})
  `).all(...ids) as Array<{ id: string; project: string | null; superseded_by: string | null }>;
  const meta = new Map(rows.map((r) => [r.id, r]));

  let hidden = 0;
  const out: T[] = [];
  for (const c of candidates) {
    const m = meta.get(c.id);
    if (c.project === undefined) c.project = m?.project ?? null;
    if (m?.superseded_by) {
      if (!includeSuperseded) {
        hidden++;
        continue;
      }
      // Kept on opt-in — flag it so callers on BOTH paths can tell which
      // results are superseded (the HTTP path has no post-slice enrichment).
      c.superseded_by = m.superseded_by;
    }
    out.push(c);
  }
  return { results: out, hidden };
}

/**
 * Collapse section/chunk documents of the same file to one result.
 *
 * Dedup key: (project, source_file). Survivor rule: POSITIONAL — the first
 * occurrence in the already-ranked input wins. No score comparison: after a
 * rerank pass, head scores are cross-encoder ranks while tail scores are raw
 * hybrid scores — they are not commensurable.
 *
 * The survivor gains `chunk_count` (total matching chunks for that file in
 * this pool) so callers know more sections exist; opt out via dedup_chunks=false.
 */
export function dedupChunks<T extends QualityCandidate>(
  results: T[],
): { results: T[]; removed: number } {
  const byKey = new Map<string, T>();
  for (const r of results) {
    const key = `${r.project ?? ''}|${r.source_file}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.chunk_count = (existing.chunk_count ?? 1) + 1;
    } else {
      byKey.set(key, r);
    }
  }
  const out = Array.from(byKey.values());
  return { results: out, removed: results.length - out.length };
}
