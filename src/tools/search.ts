/**
 * Oracle Search Handler
 *
 * Hybrid search combining FTS5 keyword search and ChromaDB vector search.
 * Exports pure helper functions (sanitizeFtsQuery, normalizeFtsScore,
 * combineResults, vectorSearch) for testability.
 */

import { logSearch } from '../server/logging.ts';
import { detectProject } from '../server/project-detect.ts';
import { rerankCandidates } from '../server/reranker.ts';
import { annotateAndFilterSuperseded, dedupChunks, normalizeBm25Rank, sanitizeFtsQuery as sharedSanitizeFtsQuery } from '../server/search-quality.ts';
import { ensureVectorStoreConnected } from '../vector/factory.ts';
import { DISABLE_LOCAL_VECTOR } from '../config.ts';
import type { SearchResult } from '../server/types.ts';
import type { ToolContext, ToolResponse, OracleSearchInput } from './types.ts';
import { writeToolTelemetry } from './telemetry.ts';

export const searchToolDef = {
  name: 'arra_search',
  description: 'Search Oracle knowledge base using hybrid search (FTS5 keywords + ChromaDB vectors). Finds relevant principles, patterns, learnings, or retrospectives. Falls back to FTS5-only if ChromaDB unavailable.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (e.g., "nothing deleted", "force push safety")'
      },
      type: {
        type: 'string',
        enum: ['principle', 'pattern', 'learning', 'retro', 'all'],
        description: 'Filter by document type',
        default: 'all'
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results',
        default: 5
      },
      offset: {
        type: 'number',
        description: 'Number of results to skip (for pagination)',
        default: 0
      },
      mode: {
        type: 'string',
        enum: ['hybrid', 'fts', 'vector'],
        description: 'Search mode: hybrid (default), fts (keywords only), vector (semantic only)',
        default: 'hybrid'
      },
      project: {
        type: 'string',
        description: 'Filter by project (e.g., "github.com/owner/repo"). Returns project + universal results.'
      },
      cwd: {
        type: 'string',
        description: 'Auto-detect project from working directory path (follows symlinks to ghq paths)'
      },
      model: {
        type: 'string',
        enum: ['nomic', 'qwen3', 'bge-m3'],
        description: 'Embedding model: bge-m3 (default, multilingual Thai↔EN, 1024-dim), nomic (fast, 768-dim), or qwen3 (cross-language, 4096-dim)',
      },
      include_superseded: {
        type: 'boolean',
        description: 'Include documents that have been superseded (hidden by default; they remain stored and flagged — Nothing is Deleted)',
        default: false
      },
      dedup_chunks: {
        type: 'boolean',
        description: 'Collapse section chunks of the same source file to one result (survivor carries chunk_count). Set false for section-level granularity.',
        default: true
      }
    },
    required: ['query']
  }
};

// ============================================================================
// Pure helper functions (exported for testing)
// ============================================================================

/**
 * Sanitize FTS5 query to prevent parse errors. Delegates to the shared
 * token-quoting sanitizer (src/server/search-quality.ts) — the previous
 * per-path deny-list let 14 characters through (=,[{$#%;&!@|<\) and the
 * empty branch returned the RAW query; both crashed MATCH (fix 2026-08-22).
 * Returns '' when the query has no searchable tokens — caller skips FTS.
 */
export function sanitizeFtsQuery(query: string): string {
  return sharedSanitizeFtsQuery(query);
}

/**
 * Normalize FTS5 rank to a 0-1 score, higher = better.
 * FTS5 rank is negative and MORE-negative = BETTER match — delegates to the
 * shared monotone-increasing normalizer (bug fix 2026-08-22: the previous
 * exp(-0.3|rank|) was monotonically DECREASING in match quality, emitting
 * fts-mode pages worst-first for ~8 months).
 */
export function normalizeFtsScore(rank: number): number {
  return normalizeBm25Rank(rank);
}

/**
 * Parse concepts from metadata (JSON string or array).
 */
export function parseConceptsFromMetadata(concepts: unknown): string[] {
  if (!concepts) return [];
  if (Array.isArray(concepts)) return concepts;
  if (typeof concepts === 'string') {
    if (concepts.length === 0) return [];
    try {
      const parsed = JSON.parse(concepts);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // LanceDB stores concepts as comma-separated strings (not JSON arrays).
      // Preserve the raw string content: split on comma if present, else wrap.
      if (concepts.includes(',')) {
        return concepts.split(',').map(s => s.trim()).filter(Boolean);
      }
      return [concepts];
    }
  }
  return [];
}

/**
 * Vector search using ChromaMcpClient.
 * Performs semantic similarity search on the oracle_knowledge collection.
 */
/**
 * Look up authoritative `source_file` values for a batch of document ids.
 *
 * The DB is the authority; LanceDB metadata is an embed-time snapshot that goes
 * stale the moment a document is rehomed to another project scope.
 *
 * Chunked because bun:sqlite rejects very large bind sets long before
 * SQLITE_MAX_VARIABLE_NUMBER — Codex audit 2026-07-27: 65,536 ids threw
 * "expected 0 values, received 65536", the caller's catch swallowed it, and every
 * result silently reverted to stale metadata (a fail-open introduced while fixing
 * a fail-silent).
 *
 * Ids with no row are simply absent from the returned map; the caller keeps
 * whatever provenance it already had.
 */
export function resolveSourceFilesFromDb(
  sqlite: { prepare: (sql: string) => { all: (...params: string[]) => unknown[] } },
  ids: string[],
  chunkSize = 500
): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += chunkSize) {
    const slice = ids.slice(i, i + chunkSize);
    // Per-chunk isolation. A single throwing chunk must not discard the chunks
    // that already succeeded — the caller's outer catch used to swallow the
    // exception and fall back to stale metadata for the ENTIRE result set, so a
    // failure on chunk 2 of 5 silently poisoned chunk 1's correct provenance.
    // Found by a second Codex audit, 2026-07-27.
    try {
      const rows = sqlite
        .prepare(
          `SELECT id, source_file FROM oracle_documents WHERE id IN (${slice.map(() => '?').join(',')})`
        )
        .all(...slice) as Array<{ id: string; source_file: string }>;
      for (const r of rows) out.set(r.id, r.source_file);
    } catch (e) {
      // Name the failing range so a partial result is diagnosable, not silent.
      console.error(`[resolveSourceFilesFromDb] chunk ${i}..${i + slice.length - 1} failed, those ids keep vector metadata: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

export async function vectorSearch(
  ctx: ToolContext,
  query: string,
  type: string,
  limit: number,
  model?: string
): Promise<Array<{
  id: string;
  type: string;
  content: string;
  source_file: string;
  concepts: string[];
  score: number;
  distance: number;
  model: string;
  source: 'vector';
}>> {
  try {
    const whereFilter = type !== 'all' ? { type } : undefined;
    const store = model ? await ensureVectorStoreConnected(model) : ctx.vectorStore;
    console.error(`[VectorSearch] Query: "${query.substring(0, 50)}..." limit=${limit} model=${model || 'default'}`);

    const results = await store.query(query, limit, whereFilter);
    console.error(`[VectorSearch] Results: ${results.ids?.length || 0} documents`);

    if (!results.ids || results.ids.length === 0) {
      return [];
    }

    const resolvedModelName = model || 'bge-m3';
    const mappedResults: Array<{
      id: string;
      type: string;
      content: string;
      source_file: string;
      concepts: string[];
      score: number;
      distance: number;
      model: string;
      source: 'vector';
    }> = [];

    for (let i = 0; i < results.ids.length; i++) {
      const metadata = results.metadatas[i] as Record<string, unknown> | null;

      const rawDistance = results.distances[i] || 0;
      mappedResults.push({
        id: results.ids[i],
        type: (metadata?.type as string) || 'unknown',
        content: (results.documents[i] || '').substring(0, 500),
        source_file: (metadata?.source_file as string) || '',
        concepts: parseConceptsFromMetadata(metadata?.concepts),
        score: rawDistance,
        distance: rawDistance,
        model: resolvedModelName,
        source: 'vector',
      });
    }

    // The DB is the authority for source_file, not the vector metadata.
    // Metadata is a snapshot taken at embed time and goes stale the moment a
    // document is rehomed to another project scope. Verified 2026-07-27: after
    // 49 misfiled learnings were moved, vector results still reported their old
    // path and `arra_read({file})` on that path returned "File not found",
    // while `arra_read({id})` worked. Re-embedding would fix those 49; joining
    // the DB fixes the whole class, for every future move.
    if (mappedResults.length > 0) {
      try {
        const ids = mappedResults.map((r) => r.id);
        const authoritative = resolveSourceFilesFromDb(ctx.sqlite, ids);
        // Ids present in the vector store but absent from oracle_documents keep
        // their embed-time metadata — there is nothing more authoritative to use.
        // Real example: learning_2026-05-24_vault-verify-marker-multiproject-…
        const orphans = ids.length - authoritative.size;
        if (orphans > 0) {
          console.error(`[VectorSearch] ${orphans}/${ids.length} ids absent from oracle_documents — those keep vector metadata`);
        }
        for (const r of mappedResults) {
          const fromDb = authoritative.get(r.id);
          if (fromDb) r.source_file = fromDb;
        }
      } catch (e) {
        // Never fail a search over provenance enrichment — fall back to metadata.
        console.error('[VectorSearch] source_file DB join failed:', e instanceof Error ? e.message : String(e));
      }
    }

    return mappedResults;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.stack || error.message : String(error);
    console.error('[ChromaDB ERROR]', errorMsg);
    return [];
  }
}

/**
 * Combine FTS and vector search results.
 * Deduplicates by document id, calculates hybrid score with 10% boost.
 */
export function combineResults(
  ftsResults: Array<{
    id: string;
    type: string;
    content: string;
    source_file: string;
    concepts: string[];
    score: number;
    source: 'fts';
  }>,
  vectorResults: Array<{
    id: string;
    type: string;
    content: string;
    source_file: string;
    concepts: string[];
    score: number;
    distance: number;
    model: string;
    source: 'vector';
  }>,
  ftsWeight: number = 0.5,
  vectorWeight: number = 0.5
): Array<{
  id: string;
  type: string;
  content: string;
  source_file: string;
  concepts: string[];
  score: number;
  source: 'fts' | 'vector' | 'hybrid';
  ftsScore?: number;
  vectorScore?: number;
  distance?: number;
  model?: string;
}> {
  const resultMap = new Map<string, {
    id: string;
    type: string;
    content: string;
    source_file: string;
    concepts: string[];
    ftsScore?: number;
    vectorScore?: number;
    distance?: number;
    model?: string;
    source: 'fts' | 'vector' | 'hybrid';
  }>();

  // Add FTS results
  for (const result of ftsResults) {
    resultMap.set(result.id, {
      id: result.id,
      type: result.type,
      content: result.content,
      source_file: result.source_file,
      concepts: result.concepts,
      ftsScore: result.score,
      source: 'fts',
    });
  }

  // Add/merge vector results
  for (const result of vectorResults) {
    const existing = resultMap.get(result.id);
    if (existing) {
      existing.vectorScore = result.score;
      existing.source = 'hybrid';
      existing.distance = result.distance;
      existing.model = result.model;
    } else {
      resultMap.set(result.id, {
        id: result.id,
        type: result.type,
        content: result.content,
        source_file: result.source_file,
        concepts: result.concepts,
        vectorScore: result.score,
        distance: result.distance,
        model: result.model,
        source: 'vector',
      });
    }
  }

  // Calculate hybrid scores
  const combined = Array.from(resultMap.values()).map((result) => {
    let score: number;

    if (result.source === 'hybrid') {
      const fts = result.ftsScore ?? 0;
      const vec = result.vectorScore ?? 0;
      // Cap at 1.0, mirroring the HTTP twin (handlers.ts combineSearchResults).
      // The 1.1 both-stream bonus could not overflow while ftsScore was ~1e-3
      // under the old inverted normalizer; with the corrected normalizer an
      // exact-phrase hit (fts ~0.99) plus a close vector hit (vec > 0.85)
      // reaches 1.03, breaking the documented 0-1 score contract.
      score = Math.min(1, ((ftsWeight * fts) + (vectorWeight * vec)) * 1.1);
    } else if (result.source === 'fts') {
      score = (result.ftsScore ?? 0) * ftsWeight;
    } else {
      score = (result.vectorScore ?? 0) * vectorWeight;
    }

    return {
      id: result.id,
      type: result.type,
      content: result.content,
      source_file: result.source_file,
      concepts: result.concepts,
      score,
      source: result.source,
      ftsScore: result.ftsScore,
      vectorScore: result.vectorScore,
      distance: result.distance,
      model: result.model,
    };
  });

  combined.sort((a, b) => b.score - a.score);
  return combined;
}

// ============================================================================
// Handler
// ============================================================================

export async function handleSearch(ctx: ToolContext, input: OracleSearchInput): Promise<ToolResponse> {
  const startTime = Date.now();
  const {
    query, type = 'all', limit = 5, offset = 0, mode = 'hybrid', project, cwd, model,
    include_superseded = false, dedup_chunks = true,
  } = input;

  if (!query || query.trim().length === 0) {
    throw new Error('Query cannot be empty');
  }

  const safeQuery = sanitizeFtsQuery(query);

  // Auto-detect project from cwd if not explicitly specified
  const resolvedProject = (project ?? detectProject(cwd))?.toLowerCase() ?? null;

  // Project filter: if project specified, include project + universal (NULL)
  // If no project, return ALL documents (no filter)
  const projectFilter = resolvedProject
    ? 'AND (d.project = ? OR d.project IS NULL)'
    : '';
  const projectParams = resolvedProject ? [resolvedProject] : [];

  let warning: string | undefined;
  let vectorSearchError = false;
  let ftsError = false;

  // Run FTS5 search (skip if vector-only mode, or if sanitization left no
  // searchable tokens — never send a raw/empty query to MATCH)
  let ftsRawResults: any[] = [];
  if (mode !== 'vector' && !safeQuery) {
    warning = 'Query has no FTS-searchable tokens — FTS5 leg skipped.';
  } else if (mode !== 'vector') {
    try {
      if (type === 'all') {
        const stmt = ctx.sqlite.prepare(`
          SELECT f.id, f.content, d.type, d.source_file, d.concepts, rank
          FROM oracle_fts f
          JOIN oracle_documents d ON f.id = d.id
          WHERE oracle_fts MATCH ? ${projectFilter}
          ORDER BY rank
          LIMIT ?
        `);
        ftsRawResults = stmt.all(safeQuery, ...projectParams, limit * 2);
      } else {
        const stmt = ctx.sqlite.prepare(`
          SELECT f.id, f.content, d.type, d.source_file, d.concepts, rank
          FROM oracle_fts f
          JOIN oracle_documents d ON f.id = d.id
          WHERE oracle_fts MATCH ? AND d.type = ? ${projectFilter}
          ORDER BY rank
          LIMIT ?
        `);
        ftsRawResults = stmt.all(safeQuery, type, ...projectParams, limit * 2);
      }
    } catch (error) {
      // Durable DEFECT-2 fallback: the sanitizer is not provably complete;
      // an FTS5 parse failure must degrade to vector-only, not kill the
      // search (live case 2026-08-22: "EfficientIP check=1 DHCP overwrite"
      // errored in hybrid while vector mode found the right gotcha).
      ftsError = true;
      ftsRawResults = [];
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[FTS5]', msg);
      warning = `FTS5 query failed: ${msg}.${mode === 'fts' ? '' : ' Returning vector-only results.'}`;
    }
  }

  // Run vector search (skip if fts-only mode OR if local vector is disabled
  // by env. ORACLE_DISABLE_LOCAL_VECTOR=true bypasses the in-process LanceDB
  // call because the host CPU lacks AVX2 — LanceDB ≥0.27 emits AVX2 SIMD
  // inside query() and crashes Bun with SIGILL on AVX-only CPUs. The crash
  // is at the C-binding level, so a try/catch cannot rescue it; the only
  // safe option is to skip the call entirely.)
  let vecResults: Awaited<ReturnType<typeof vectorSearch>> = [];
  if (mode !== 'fts' && DISABLE_LOCAL_VECTOR) {
    vectorSearchError = true;
    warning = warning ? `${warning} Local vector adapter disabled (ORACLE_DISABLE_LOCAL_VECTOR).` : 'Local vector adapter disabled (ORACLE_DISABLE_LOCAL_VECTOR). Returning FTS5 results.';
  } else if (mode !== 'fts') {
    try {
      vecResults = await vectorSearch(ctx, query, type, limit * 2, model);
    } catch (error) {
      vectorSearchError = true;
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[ChromaDB]', errorMessage);
      warning = warning ? `${warning} Vector search unavailable: ${errorMessage}.` : `Vector search unavailable: ${errorMessage}. Using FTS5 only.`;
    }

    if (vecResults.length === 0 && !vectorSearchError) {
      warning = warning || 'Vector search returned no results. Using FTS5 results.';
    }
  }

  // Transform FTS results to normalized format
  const ftsResults = ftsRawResults.map((row: any) => ({
    id: row.id,
    type: row.type,
    content: row.content.substring(0, 500),
    source_file: row.source_file,
    concepts: JSON.parse(row.concepts || '[]') as string[],
    score: normalizeFtsScore(row.rank),
    source: 'fts' as const,
  }));

  // Normalize vector scores (ChromaDB distances: lower = better → invert)
  const normalizedVectorResults = vecResults.map((result) => ({
    ...result,
    score: 1 - (result.score || 0),
  }));

  const combinedResults = combineResults(ftsResults, normalizedVectorResults);

  // Quality pass 1 (shared with HTTP path — src/server/search-quality.ts):
  // annotate project (dedup key) + hide superseded docs unless opted in.
  // Runs BEFORE rerank so the reranker pool isn't wasted on hidden docs.
  const supersededPass = annotateAndFilterSuperseded(
    ctx.sqlite,
    combinedResults as Array<(typeof combinedResults)[number] & { project?: string | null; chunk_count?: number }>,
    include_superseded,
  );

  // Reranker pass — cross-encoder over the top of the hybrid list.
  // No-op when ORACLE_RERANKER_URL is unset (the helper pass-throughs).
  // Empirical lift: +14.3 pts R@1 on cross-language Thai/EN smoke test.
  const RERANK_POOL_SIZE = 50;
  const rerankHead = supersededPass.results.slice(0, RERANK_POOL_SIZE);
  const rerankTail = supersededPass.results.slice(RERANK_POOL_SIZE);
  const reranked = await rerankCandidates({
    query,
    candidates: rerankHead,
    getText: (r) => r.content,
  });
  const rankedResults = reranked.reranked
    ? [...reranked.results, ...rerankTail]
    : supersededPass.results;

  // Quality pass 2: collapse section chunks per (project, source_file).
  // AFTER rerank (positional survivor — no cross-boundary score comparison),
  // BEFORE pagination slice (no duplicates across pages). May under-fill
  // `limit` when many top hits collapse — expected, surfaced via metadata.
  const dedupPass = dedup_chunks
    ? dedupChunks(rankedResults)
    : { results: rankedResults, removed: 0 };
  const finalResults = dedupPass.results;

  const totalMatches = finalResults.length;
  const results: Array<Record<string, unknown>> = finalResults.slice(offset, offset + limit);

  // Enrich with supersede flags (P-001 "Nothing is Deleted" — superseded docs
  // remain searchable; callers need to see the flag to decide whether to
  // follow the replacement pointer). Fixes drift where arra_supersede claimed
  // "will appear in searches with a warning" but search never flagged them.
  if (results.length > 0) {
    const ids = results.map(r => r.id as string);
    const placeholders = ids.map(() => '?').join(',');
    const supersedeRows = ctx.sqlite.prepare(`
      SELECT id, superseded_by, superseded_at, superseded_reason
      FROM oracle_documents
      WHERE id IN (${placeholders}) AND superseded_by IS NOT NULL
    `).all(...ids) as Array<{
      id: string;
      superseded_by: string;
      superseded_at: number;
      superseded_reason: string | null;
    }>;
    const supersedeMap = new Map(supersedeRows.map(r => [r.id, r]));
    for (const r of results) {
      const s = supersedeMap.get(r.id as string);
      if (s) {
        r.superseded_by = s.superseded_by;
        r.superseded_at = new Date(s.superseded_at).toISOString();
        r.superseded_reason = s.superseded_reason;
      }
    }
  }

  const ftsCount = results.filter((r) => r.source === 'fts').length;
  const vectorCount = results.filter((r) => r.source === 'vector').length;
  const hybridCount = results.filter((r) => r.source === 'hybrid').length;
  const searchTime = Date.now() - startTime;

  const metadata: {
    mode: string;
    limit: number;
    offset: number;
    total: number;
    ftsMatches: number;
    vectorMatches: number;
    sources: { fts: number; vector: number; hybrid: number };
    searchTime: number;
    superseded_hidden: number;
    deduped_removed: number;
    reranked?: boolean;
    rerankFallbackReason?: string;
    warning?: string;
    ftsError?: boolean;
  } = {
    mode,
    limit,
    offset,
    total: totalMatches,
    ftsMatches: ftsRawResults.length,
    vectorMatches: vecResults.length,
    sources: { fts: ftsCount, vector: vectorCount, hybrid: hybridCount },
    searchTime,
    // Counts are scoped to THIS candidate pool, not corpus-wide.
    superseded_hidden: supersededPass.hidden,
    deduped_removed: dedupPass.removed,
    reranked: reranked.reranked,
    ...(reranked.fallbackReason ? { rerankFallbackReason: reranked.fallbackReason } : {}),
    ...(ftsError ? { ftsError: true } : {}),
  };

  if (warning) {
    metadata.warning = warning;
  }

  writeToolTelemetry(ctx, () => {
    console.error(`[MCP:SEARCH] "${query}" (${type}, ${mode}, model=${model || 'default'}) → ${results.length} results in ${searchTime}ms`);
    try {
      logSearch(query, type, mode, results.length, searchTime, results as unknown as SearchResult[]);
    } catch (e) {
      console.error('[MCP:SEARCH] Failed to log search to database:', e);
    }
  });

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ results, total: results.length, query, metadata }, null, 2)
    }]
  };
}
