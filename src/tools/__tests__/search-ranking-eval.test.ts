/**
 * Search ranking eval harness — regression gate for the FTS5 bm25
 * normalization inversion bug (introduced 2026-01-02 commit 7aee7fc,
 * fixed 2026-08-22).
 *
 * Hand-built in-memory fixture corpus + golden queries. Calls the REAL
 * exported handleSearch() (src/tools/search.ts) against a fixture bun:sqlite
 * DB built with the production initFts5() DDL (porter unicode61) — not a
 * re-implementation of the pipeline.
 *
 * Metrics:
 *  1. Exact-order gate (ABSOLUTE, not ratcheted): for each golden query,
 *     the emitted id sequence (mode:'fts', dedup_chunks:false) must equal
 *     SQL `ORDER BY rank` exactly — reported as Kendall tau, must be +1.0.
 *     On the buggy normalizer this is the exact reverse (tau = -1.0).
 *  2. Judged top-1 accuracy (ratcheted floor) — human-labeled topical
 *     relevance, deliberately includes a bm25-vs-judged trap (Q7) so the
 *     metric has headroom below 1.0.
 *  3. Judged Recall@5 (ratcheted floor) — catches "true top pushed off
 *     page 1" (Q6: 8-result pool).
 *  4. Dedup survivor (behavioral, absolute): the best chunk of a
 *     multi-chunk file must survive dedup_chunks:true (Q5) — pins the
 *     compounding bug where positional-first-wins dedup keeps the WORST
 *     chunk when its input order is inverted.
 *
 * Ratchet floors: src/tools/__tests__/fixtures/search-eval-baseline.json
 *   Raise: ORACLE_EVAL_UPDATE_BASELINE=1 bun test <this file>
 *   Lower: hand-edit the JSON in a reviewed commit with justification.
 * Print SQL ground truth: ORACLE_EVAL_PRINT_TRUTH=1 bun test <this file>
 *
 * UNVERIFIED-until-run (per plan Part 1.1): in-memory FTS5 with
 * `porter unicode61` under bun:sqlite works via the production initFts5().
 * If it throws, that assumption is broken — the test will fail loudly in
 * beforeAll rather than silently.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { handleSearch, sanitizeFtsQuery } from '../search.ts';
import { initFts5 } from '../../db/index.ts';
import type { ToolContext } from '../types.ts';

// ---------------------------------------------------------------------------
// Fixture corpus — term densities engineer the bm25 spread. Content is
// deliberately bag-of-words (not prose): bm25 scores term frequency +
// document length, not word order, so this is more controllable/reproducible
// than hand-counting occurrences inside natural sentences. Deviation from
// the plan's "prose gist" framing — noted in the implementation report.
// ---------------------------------------------------------------------------

interface DocSpec {
  id: string;
  source_file: string;
  terms: Record<string, number>;
  /** Filler word count to pad doc length; default 10. */
  padding?: number;
}

const FILLER = ['note', 'system', 'network', 'config', 'document', 'entry', 'item', 'detail', 'context', 'summary'];

function buildContent(terms: Record<string, number>, padding = 10): string {
  const words: string[] = [];
  for (const [term, count] of Object.entries(terms)) {
    for (let i = 0; i < count; i++) words.push(term);
  }
  for (let i = 0; i < padding; i++) words.push(FILLER[i % FILLER.length]);
  return words.join(' ');
}

const DOCS: DocSpec[] = [
  // Q1/Q10 smoking-gun pair: D01 dense exact-topic, D02 sparse but still
  // matches all 4 AND-terms (weak) so the pool has 2 comparable members.
  { id: 'D01', source_file: 'gotcha/routemap.md', terms: { route: 3, map: 3, undefined: 2, advertise: 3, bgp: 2, outbound: 2 } },
  { id: 'D02', source_file: 'case/curbside.md', terms: { route: 1, map: 1, undefined: 1, advertise: 1, bgp: 1, outbound: 1, cutover: 2, curbside: 2 } },
  // Q2/Q8 pair: D03 dense pexpect/banner/truncation doc, D04 weak-but-matches-all-3,
  // D05 banner-only (no pexpect/truncation — excluded from Q2's AND match,
  // included in Q8's single-term "banner" pool).
  { id: 'D03', source_file: 'gotcha/pexpect.md', terms: { pexpect: 3, banner: 4, truncation: 3 } },
  { id: 'D04', source_file: 'ref/pexpect-retry.md', terms: { pexpect: 1, banner: 1, truncation: 1, retry: 2 } },
  { id: 'D05', source_file: 'ref/banner-motd.md', terms: { banner: 2, motd: 2 } },
  // Q3/Q9 pair: D06 dense force/push/safety, D07 weak-but-matches (also feeds Q9).
  { id: 'D06', source_file: 'rule/force-push.md', terms: { force: 3, push: 3, safety: 2 } },
  { id: 'D07', source_file: 'ref/git-flow.md', terms: { push: 1, git: 2, flow: 2, force: 1, safety: 1 } },
  // Q4 Thai multi-term pair. Tokenizer is unicode61 (no Thai segmentation) —
  // matches only on whitespace-delimited runs, hence space-separated text.
  { id: 'D08', source_file: 'thai/verify.md', terms: { 'ตรวจสอบ': 2, 'ก่อน': 2, push: 2 } },
  { id: 'D09', source_file: 'thai/done.md', terms: { push: 1, 'งาน': 1, 'เสร็จ': 1, 'แล้ว': 1 }, padding: 4 },
  // Q5 dedup-survivor pair: SAME source_file, 2 distinct ids. D10a = weak
  // chunk, D10b = dense chunk. dedupChunks is positional-first-wins over the
  // ALREADY-RANKED input, so this pins whether the ranking bug feeds the
  // wrong chunk into the survivor slot.
  { id: 'D10a', source_file: 'chunks/dedup-target.md', terms: { dedup: 1, chunks: 1, survivor: 1 }, padding: 4 },
  { id: 'D10b', source_file: 'chunks/dedup-target.md', terms: { dedup: 3, chunks: 3, survivor: 3, positional: 1, wins: 1 } },
  // Q6 Recall@5 case: 8 distinct densities -> 8 distinct ranks, true best
  // (D18) must not be pushed off a 5-result page by the inversion.
  ...Array.from({ length: 8 }, (_, i) => ({
    id: `D${11 + i}`,
    source_file: `wave/w${i + 1}.md`,
    terms: { wave: i + 1, migration: i + 1, checklist: i + 1 },
  })),
  // Q7 semantic trap: D19 is the topically-correct paraphrase (judged best);
  // D20 is keyword-stuffed and WILL out-rank it on bm25 — this is intentional
  // ratchet headroom (judged accuracy < 1.0 by design), not a bug.
  { id: 'D19', source_file: 'principle/nothing-deleted.md', terms: { nothing: 1, deleted: 1, artifact: 2, stays: 1, supersede: 1, overwrite: 1 } },
  { id: 'D20', source_file: 'log/spam.md', terms: { nothing: 3, deleted: 3 }, padding: 4 },
];

function setupFixtureDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE oracle_documents (
      id TEXT PRIMARY KEY, type TEXT, source_file TEXT, concepts TEXT,
      project TEXT, superseded_by TEXT, superseded_at INTEGER, superseded_reason TEXT
    );
  `);
  initFts5(db); // production DDL — porter unicode61, id/content/concepts
  const insDoc = db.prepare(
    `INSERT INTO oracle_documents (id, type, source_file, concepts, project, superseded_by, superseded_at, superseded_reason)
     VALUES (?, 'learning', ?, '[]', NULL, NULL, NULL, NULL)`
  );
  const insFts = db.prepare(`INSERT INTO oracle_fts (id, content, concepts) VALUES (?, ?, '[]')`);
  for (const d of DOCS) {
    const content = buildContent(d.terms, d.padding ?? 10);
    insDoc.run(d.id, d.source_file);
    insFts.run(d.id, content);
  }
  return db;
}

function makeCtx(db: Database): ToolContext {
  return {
    db: null as any,
    sqlite: db,
    repoRoot: '/fake/eval-fixture',
    vectorStore: null as any,
    vectorStatus: 'unavailable',
    version: 'eval-harness',
    telemetryEnabled: false,
  };
}

// ---------------------------------------------------------------------------
// Golden queries
// ---------------------------------------------------------------------------

interface GoldenQuery {
  name: string;
  query: string;
  /** Human-judged topically-correct top result. Undefined = tau-only query. */
  judgedTop?: string;
}

const GOLDEN: GoldenQuery[] = [
  { name: 'Q1', query: 'route-map undefined advertise', judgedTop: 'D01' }, // live smoking gun
  { name: 'Q2', query: 'pexpect banner truncation', judgedTop: 'D03' },
  { name: 'Q3', query: 'force push safety', judgedTop: 'D06' },
  { name: 'Q4', query: 'ตรวจสอบ ก่อน push', judgedTop: 'D08' }, // Thai multi-term
  { name: 'Q5', query: 'dedup chunks survivor' }, // behavioral case, own assertion
  { name: 'Q6', query: 'wave migration checklist', judgedTop: 'D18' }, // Recall@5 case
  { name: 'Q7', query: 'nothing deleted', judgedTop: 'D19' }, // semantic trap: judged != bm25
  { name: 'Q8', query: 'banner' }, // narrow-spread single term, tau only
  { name: 'Q9', query: 'push' }, // broad single term, tau only
  { name: 'Q10', query: 'BGP outbound', judgedTop: 'D01' },
];

const JUDGED = GOLDEN.filter((g) => g.judgedTop);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sqlGroundTruth(db: Database, query: string): string[] {
  const safe = sanitizeFtsQuery(query);
  const rows = db
    .prepare(`SELECT id, rank FROM oracle_fts WHERE oracle_fts MATCH ? ORDER BY rank`)
    .all(safe) as Array<{ id: string; rank: number }>;
  return rows.map((r) => r.id);
}

async function emittedOrder(
  ctx: ToolContext,
  query: string,
  opts: { limit?: number; dedup_chunks?: boolean } = {}
): Promise<string[]> {
  const resp = await handleSearch(ctx, {
    query,
    mode: 'fts',
    limit: opts.limit ?? 25,
    dedup_chunks: opts.dedup_chunks ?? false,
  });
  const text = resp.content[0]!.text;
  const parsed = JSON.parse(text) as { results: Array<{ id: string }> };
  return parsed.results.map((r) => r.id);
}

/** Kendall tau of `a`'s order relative to `b` as ground truth. null if <2 comparable items. */
function kendallTau(a: string[], b: string[]): number | null {
  const posB = new Map(b.map((id, i) => [id, i]));
  const ids = a.filter((id) => posB.has(id));
  const n = ids.length;
  if (n < 2) return null;
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (posB.get(ids[i]!)! < posB.get(ids[j]!)!) concordant++;
      else discordant++;
    }
  }
  const total = (n * (n - 1)) / 2;
  return (concordant - discordant) / total;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('search ranking eval harness (FTS5 bm25 normalization regression gate)', () => {
  let db: Database;
  let ctx: ToolContext;

  beforeAll(() => {
    // Environment assumption: reranker must be self-disabled (no live sidecar
    // reachable in CI); a future re-sort inside handleSearch would otherwise
    // be silently masked by this harness. Actively clear rather than assert:
    // src/server/__tests__/reranker.test.ts:27's afterEach only restores this
    // var when it was truthy BEFORE that file ran, so its "reads URL from
    // process.env" test leaks ORACLE_RERANKER_URL=http://from-env into every
    // later file in the same `bun test` process (pre-existing cross-file
    // pollution, out of scope to fix here — deleting is robust to run order).
    delete process.env.ORACLE_RERANKER_URL;

    db = setupFixtureDb();
    ctx = makeCtx(db);

    if (process.env.ORACLE_EVAL_PRINT_TRUTH === '1') {
      console.log('\n=== GROUND TRUTH (SQL `ORDER BY rank`, best match first) ===');
      for (const g of GOLDEN) {
        console.log(`${g.name} "${g.query}" ->`, JSON.stringify(sqlGroundTruth(db, g.query)));
      }
    }
  });

  test('exact-order gate: emitted sequence equals SQL ORDER BY rank (Kendall tau, absolute)', async () => {
    const rows: Array<{ name: string; tau: number | null; emitted: string[]; truth: string[] }> = [];
    for (const g of GOLDEN) {
      const truth = sqlGroundTruth(db, g.query);
      const emitted = await emittedOrder(ctx, g.query, { limit: 25, dedup_chunks: false });
      const tau = kendallTau(emitted, truth);
      rows.push({ name: g.name, tau, emitted, truth });
    }

    // Verbatim diagnostic output — required by the runbook's RED/GREEN capture.
    for (const r of rows) {
      console.log(`[tau] ${r.name} tau=${r.tau} emitted=${JSON.stringify(r.emitted)} truth=${JSON.stringify(r.truth)}`);
    }

    const comparable = rows.filter((r) => r.tau !== null);
    expect(comparable.length).toBeGreaterThan(0); // sanity: at least one multi-result query exists

    for (const r of comparable) {
      expect(r.tau).toBeCloseTo(1, 9);
    }
  });

  test('dedup survivor: best chunk of dedup-target.md survives dedup_chunks:true', async () => {
    const emitted = await emittedOrder(ctx, 'dedup chunks survivor', { limit: 25, dedup_chunks: true });
    console.log(`[dedup-survivor] emitted=${JSON.stringify(emitted)}`);
    expect(emitted).toContain('D10b');
    expect(emitted).not.toContain('D10a');
  });

  test('judged top-1 accuracy + Recall@5 (ratcheted floors)', async () => {
    let top1Hits = 0;
    let recall5Hits = 0;
    const misses: string[] = [];

    for (const g of JUDGED) {
      const emitted = await emittedOrder(ctx, g.query, { limit: 5, dedup_chunks: false });
      const top5 = emitted.slice(0, 5);
      const top1ok = top5[0] === g.judgedTop;
      const recall5ok = top5.includes(g.judgedTop!);
      if (top1ok) top1Hits++;
      else misses.push(`miss(top1): query=${g.name} expected=${g.judgedTop} top5=${JSON.stringify(top5)}`);
      if (recall5ok) recall5Hits++;
      else misses.push(`miss(recall5): query=${g.name} expected=${g.judgedTop} top5=${JSON.stringify(top5)}`);
    }

    const top1 = top1Hits / JUDGED.length;
    const recall5 = recall5Hits / JUDGED.length;
    console.log(`[judged] top1=${top1} (${top1Hits}/${JUDGED.length}) recall5=${recall5} (${recall5Hits}/${JUDGED.length})`);
    if (misses.length) console.log(misses.join('\n'));

    const baselinePath = join(import.meta.dir, 'fixtures', 'search-eval-baseline.json');
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8')) as {
      judged_top1_min: number;
      judged_recall5_min: number;
    };

    if (process.env.ORACLE_EVAL_UPDATE_BASELINE === '1') {
      const updated = {
        ...baseline,
        judged_top1_min: Math.max(baseline.judged_top1_min, top1),
        judged_recall5_min: Math.max(baseline.judged_recall5_min, recall5),
        updated: new Date().toISOString(),
      };
      writeFileSync(baselinePath, JSON.stringify(updated, null, 2) + '\n');
      console.log(`RATCHET updated: judged_top1_min=${updated.judged_top1_min} judged_recall5_min=${updated.judged_recall5_min}`);
    }

    expect(top1).toBeGreaterThanOrEqual(baseline.judged_top1_min - 1e-9);
    expect(recall5).toBeGreaterThanOrEqual(baseline.judged_recall5_min - 1e-9);
  });
});
