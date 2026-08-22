/**
 * Executes the REAL local vector leg of handleSearch (handlers.ts) under the
 * strict harness — the lines fixed by 578526e + 12a2124, which until this
 * file ran in NO test (tests/preload.ts forces ORACLE_DISABLE_LOCAL_VECTOR
 * =true; that is why 1/(1+d/100) survived 7 months).
 *
 * Pattern precedent: src/tools/__tests__/search-fts-fallback.test.ts —
 * never weaken the rail (env stays 'true', test-safety still asserts it);
 * mock the compiled const + the adapter factory instead, so LanceDB native
 * code (the AVX2/SIGILL hazard) is structurally unreachable. mock.module is
 * process-wide; bunfig [test].isolate=true confines it to this file.
 *
 * Falsification (recorded 2026-08-23, plan f2-f4): run verbatim against
 * `git show 578526e~1:src/server/handlers.ts` → RED with score 0.99741 and
 * the FTS target absent from the hybrid page — the original incident shape.
 */
import { describe, test, expect, mock } from 'bun:test';

const CONFIG = '../../config.ts';
const actualConfig = await import(CONFIG);
mock.module(CONFIG, () => ({ ...actualConfig, DISABLE_LOCAL_VECTOR: false }));

function makeStub(payload: { ids: string[]; documents: string[]; distances: number[]; metadatas: unknown[] }) {
  return {
    name: 'stub',
    connect: async () => {}, close: async () => {},
    ensureCollection: async () => {}, deleteCollection: async () => {},
    addDocuments: async () => {},
    query: async () => payload,
    queryById: async () => ({ ids: [], documents: [], distances: [], metadatas: [] }),
    getStats: async () => ({ count: payload.ids.length }),
    getCollectionInfo: async () => ({ count: payload.ids.length, name: 'stub' }),
  };
}

// 2 measured hits at realistic dot-distances + 1 ghost (distances array
// shorter than ids — the `|| 0` regression input from 12a2124).
const unitStub = makeStub({
  ids: ['VDOC_NEAR', 'VDOC_FAR', 'VDOC_GHOST'],
  documents: ['near doc content', 'far doc content', 'ghost doc content'],
  distances: [0.26, 0.61],
  metadatas: [
    { type: 'learning', source_file: 'fixture/near.md' },
    { type: 'learning', source_file: 'fixture/far.md' },
    { type: 'learning', source_file: 'fixture/ghost.md' },
  ],
});

// 8 mediocre vector hits sweeping the measured band [0.26, 0.61] — none is
// the document the user asked for (the incident's noise wall).
const N = 8;
const retroStub = makeStub({
  ids: Array.from({ length: N }, (_, i) => `VNOISE_${i}`),
  documents: Array.from({ length: N }, (_, i) => `unrelated vector doc ${i}`),
  distances: Array.from({ length: N }, (_, i) => 0.26 + (0.35 * i) / (N - 1)),
  metadatas: Array.from({ length: N }, (_, i) => ({ type: 'learning', source_file: `fixture/vnoise-${i}.md` })),
});

let activeStub: ReturnType<typeof makeStub> = unitStub;
const FACTORY = '../../vector/factory.ts';
const actualFactory = await import(FACTORY);
mock.module(FACTORY, () => ({
  ...actualFactory,
  ensureVectorStoreConnected: async () => activeStub,
  getVectorStoreByModel: () => activeStub,
}));

const { sqlite } = await import('../../db/index.ts');
const { handleSearch } = await import('../handlers.ts');
const { normalizeBm25Rank } = await import('../search-quality.ts');

describe('vector leg score mapping (the 578526e + 12a2124 call site)', () => {
  test('distances map through the shared normalizer; ghost scores 0', async () => {
    activeStub = unitStub;
    const res = await handleSearch('anything', 'all', 10, 0, 'vector');
    const byId = new Map(res.results.map((r) => [r.id, r]));
    const near = byId.get('VDOC_NEAR')!, far = byId.get('VDOC_FAR')!, ghost = byId.get('VDOC_GHOST')!;
    expect(near).toBeDefined(); expect(far).toBeDefined(); expect(ghost).toBeDefined();
    expect(near.score).toBeCloseTo(0.87, 5);   // old formula: 0.99741
    expect(far.score).toBeCloseTo(0.695, 5);   // old formula: 0.99394
    expect(near.score! - far.score!).toBeGreaterThan(0.1); // old spread: 0.0034
    // the scale relationship that WAS the defect:
    expect(near.score!).toBeLessThan(normalizeBm25Rank(-20));
    // unknown distance must never outrank a measured match (12a2124):
    expect(ghost.score).toBe(0);
  });
});

describe('hybrid page survival — the original incident shape', () => {
  test('the only FTS-matching document stays on the default page against a vector noise wall', async () => {
    activeStub = retroStub;
    sqlite.prepare(`INSERT INTO oracle_documents (id, type, source_file, concepts, created_at, updated_at, indexed_at)
                    VALUES (?, 'learning', ?, '[]', 0, 0, 0)`)
      .run('FTS_TARGET', 'fixture/target.md');
    sqlite.prepare(`INSERT INTO oracle_fts (id, content, concepts) VALUES (?, ?, '[]')`)
      .run('FTS_TARGET', 'passengertransferas02 switch uplink notes');
    // bm25 idf needs a background corpus; a 1-doc index scores the exact
    // match ~0.2 and the assertion below would pass for the wrong reason.
    for (let i = 0; i < 40; i++) {
      sqlite.prepare(`INSERT INTO oracle_documents (id, type, source_file, concepts, created_at, updated_at, indexed_at)
                      VALUES (?, 'learning', ?, '[]', 0, 0, 0)`).run(`BG_${i}`, `fixture/bg-${i}.md`);
      sqlite.prepare(`INSERT INTO oracle_fts (id, content, concepts) VALUES (?, ?, '[]')`)
        .run(`BG_${i}`, `network switch fabric vlan migration wave ${i} bgp neighbor fusion route map notes uplink`);
    }
    const res = await handleSearch('passengertransferas02', 'all', 5, 0, 'hybrid');
    // Incident symptom: the ONLY document containing the token was ABSENT at
    // the default limit (rank 157/157). Presence on the page is the property;
    // rank-1 would over-fit the fixture's bm25 corpus statistics.
    expect(res.results.map((r) => r.id)).toContain('FTS_TARGET');
  });
});

// ============================================================================
// F2 — proxy vector leg (appended in the F2 commit; SAME file on purpose).
// mock.module is process-wide and bun may run several test files in ONE
// process even with [test].isolate=true (verified 2026-08-23: a sibling file
// mocking ../vector-proxy.ts leaked into this file's handleSearch when both
// ran in one invocation). The precedent's rule is literal: ONE file owns the
// handlers-affecting mocks. The proxy instance is loaded through a
// query-busted specifier AFTER the proxy mock is registered, so THIS import
// sees the fake proxy while the plain import above (already evaluated,
// vectorProxy captured as null) keeps exercising the local leg.
// ============================================================================

// A remote running OLD code: band score, but a real distance on the wire.
const fakeProxy = {
  search: async () => ({
    results: [{
      id: 'REMOTE_DOC1', type: 'learning', content: 'remote vector doc',
      source_file: 'fixture/remote1.md', concepts: [], project: null,
      source: 'vector' as const, score: 0.99489, distance: 0.5123, model: 'bge-m3',
    }],
    total: 1, offset: 0, limit: 10,
  }),
  similar: async () => null, compare: async () => null, map: async () => null,
  map3d: async () => null, stats: async () => null, available: async () => true,
};

mock.module('../vector-proxy.ts', () => ({
  createVectorProxy: () => fakeProxy,
}));

// Widened type on purpose: a literal specifier would make tsc resolve
// '../handlers.ts?leg=proxy' as a module path and fail the build.
const HANDLERS_PROXY: string = '../handlers.ts?leg=proxy';
const { handleSearch: handleSearchProxy } = await import(HANDLERS_PROXY);
const { normalizeVectorDistance } = await import('../search-quality.ts');

describe('proxy vector leg re-normalizes remote scores from distance', () => {
  test('old-code remote band score 0.9949 is recomputed to 1 - d/2', async () => {
    const res = await handleSearchProxy('remote vector doc', 'all', 10, 0, 'hybrid');
    const hit = res.results.find((r: { id: string }) => r.id === 'REMOTE_DOC1');
    expect(hit).toBeDefined();
    expect(hit!.score).toBeCloseTo(normalizeVectorDistance(0.5123), 5); // 0.74385
    expect(hit!.score).toBeLessThan(0.9); // the band can never come back through this leg
  });

  test('a remote result with NO distance scores 0 and surfaces a warning', async () => {
    fakeProxy.search = (async () => ({
      results: [{
        id: 'REMOTE_NODIST', type: 'learning', content: 'no distance doc',
        source_file: 'fixture/nodist.md', concepts: [], project: null,
        source: 'vector' as const, score: 0.99, model: 'bge-m3',
      }],
      total: 1, offset: 0, limit: 10,
    })) as never;
    const res = await handleSearchProxy('no distance doc', 'all', 10, 0, 'hybrid');
    const hit = res.results.find((r: { id: string }) => r.id === 'REMOTE_NODIST');
    expect(hit).toBeDefined();
    expect(hit!.score).toBe(0);
    expect(res.warning ?? '').toContain('without a distance');
  });
});
