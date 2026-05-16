/**
 * B3 regression test — LanceDBAdapter.query() must use 'dot' distance, not 'cosine'.
 *
 * Background: LanceDB ≥0.27 emits AVX2 SIMD inside the cosine distance code
 * path which crashes Bun with SIGILL on AVX-only CPUs (no try/catch can rescue
 * the C-binding crash). bge-m3 (and all sentence-transformers-style models)
 * returns L2-normalized embeddings — for unit vectors, dot distance equals
 * cosine distance numerically: cos_dist = 1 - dot_product.
 *
 * This test guards against accidentally reverting to `.distanceType('cosine')`.
 * Failure modes covered:
 *   1. Source-level: adapter must not call distanceType('cosine') anywhere
 *   2. Runtime:    query() against AVX-normalized vectors must not SIGILL
 *   3. Semantic:   ranking under dot must match expected order
 *   4. Value:      LanceDB's 'dot' distance == 1 - inner_product for unit vectors
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { LanceDBAdapter } from '../adapters/lancedb.ts';
import type { EmbeddingProvider, EmbedType, VectorDocument } from '../types.ts';

const ADAPTER_PATH = path.join(__dirname, '..', 'adapters', 'lancedb.ts');

/** L2-normalize an arbitrary vector */
function l2normalize(v: number[]): number[] {
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return mag > 0 ? v.map((x) => x / mag) : v;
}

/** Compute inner product (== cosine_similarity for unit vectors) */
function dot(a: number[], b: number[]): number {
  return a.reduce((s, x, i) => s + x * b[i], 0);
}

/**
 * Mock embedder that returns a *fixed* normalized query vector regardless of
 * the text — this isolates the search ranking from any embedding-side noise.
 */
class FixedQueryEmbedder implements EmbeddingProvider {
  readonly name = 'fixed-query';
  readonly dimensions = 8;
  readonly fixedQueryVector: number[];

  constructor(queryVec: number[]) {
    this.fixedQueryVector = l2normalize(queryVec);
  }

  async embed(texts: string[], _type?: EmbedType): Promise<number[][]> {
    return texts.map(() => this.fixedQueryVector);
  }
}

const TMP_BASE = path.join(os.tmpdir(), `oracle-b3-dot-${Date.now()}`);

describe('LanceDB B3 regression — dot distance instead of cosine', () => {
  describe('Source-level guard', () => {
    it('adapter source does NOT use .distanceType("cosine")', () => {
      const src = fs.readFileSync(ADAPTER_PATH, 'utf-8');
      // Match patterns like distanceType('cosine'), distanceType("cosine")
      const cosineRefs = src.match(/distanceType\(\s*['"]cosine['"]\s*\)/g);
      expect(cosineRefs).toBeNull();
    });

    it('adapter source DOES use .distanceType("dot") for vector search', () => {
      const src = fs.readFileSync(ADAPTER_PATH, 'utf-8');
      const dotRefs = src.match(/distanceType\(\s*['"]dot['"]\s*\)/g);
      // Adapter has two query paths: query(text) and queryById(id)
      expect(dotRefs).not.toBeNull();
      expect(dotRefs!.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Runtime — does not SIGILL, returns correct ranking', () => {
    let adapter: LanceDBAdapter;
    let tmpDir: string;

    // Three docs with known dot products against the query vector.
    // After normalization, doc A is closest (highest dot), doc B middle, doc C farthest.
    const QUERY_VEC = l2normalize([1, 1, 1, 1, 1, 1, 1, 1]);
    const DOC_A_VEC = l2normalize([1, 1, 1, 1, 1, 1, 1, 1]); // identical → dot ≈ 1.0
    const DOC_B_VEC = l2normalize([1, 1, 1, 1, 0, 0, 0, 0]); // overlaps half → dot ≈ 0.707
    const DOC_C_VEC = l2normalize([1, 1, 0, 0, 0, 0, 0, 0]); // overlaps quarter → dot ≈ 0.5

    beforeAll(async () => {
      tmpDir = path.join(TMP_BASE, 'col');
      fs.mkdirSync(tmpDir, { recursive: true });
      const embedder = new FixedQueryEmbedder(QUERY_VEC);
      adapter = new LanceDBAdapter('b3_dot_test', tmpDir, embedder);
      await adapter.connect();
      await adapter.ensureCollection();

      const docs: VectorDocument[] = [
        { id: 'A', document: 'identical', metadata: { type: 'test' }, vector: DOC_A_VEC },
        { id: 'B', document: 'half', metadata: { type: 'test' }, vector: DOC_B_VEC },
        { id: 'C', document: 'quarter', metadata: { type: 'test' }, vector: DOC_C_VEC },
      ];
      await adapter.addDocuments(docs);
    });

    afterAll(async () => {
      try { await adapter.deleteCollection(); } catch {}
      try { await adapter.close(); } catch {}
      try { fs.rmSync(TMP_BASE, { recursive: true, force: true }); } catch {}
    });

    it('query() does not crash with SIGILL (CPU lacks AVX2)', async () => {
      // If adapter reverts to .distanceType('cosine') and CPU has no AVX2,
      // this call will crash the test process (uncatchable C-binding SIGILL).
      const res = await adapter.query('anything', 3);
      expect(res.ids).toHaveLength(3);
    });

    it('query() returns docs ordered by descending dot product (A > B > C)', async () => {
      const res = await adapter.query('anything', 3);
      expect(res.ids).toEqual(['A', 'B', 'C']);
    });

    it('distance values match LanceDB dot-distance semantics (1 - dot_sim)', async () => {
      const res = await adapter.query('anything', 3);
      // For unit vectors, LanceDB's 'dot' distance = 1 - inner_product.
      // Compute expected from known vectors.
      const expectedA = 1 - dot(QUERY_VEC, DOC_A_VEC);
      const expectedB = 1 - dot(QUERY_VEC, DOC_B_VEC);
      const expectedC = 1 - dot(QUERY_VEC, DOC_C_VEC);
      expect(res.distances[0]).toBeCloseTo(expectedA, 4);
      expect(res.distances[1]).toBeCloseTo(expectedB, 4);
      expect(res.distances[2]).toBeCloseTo(expectedC, 4);
      // And sanity: A is closest (distance ~0), C is farthest
      expect(res.distances[0]).toBeLessThan(res.distances[2]);
    });

    it('queryById() also uses dot distance (no SIGILL, correct order)', async () => {
      // queryById fetches a doc's stored vector then searches for neighbors.
      // Uses the same distanceType('dot') guarded by the source check above.
      const res = await adapter.queryById('A', 2);
      // Should return B and C (A excluded), with B closer than C
      expect(res.ids).toEqual(['B', 'C']);
      expect(res.distances[0]).toBeLessThan(res.distances[1]);
    });
  });
});
