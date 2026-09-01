import { describe, expect, it } from 'bun:test';

const NEW_PRODUCTION_MODULES = [
  '../canonical.ts', '../persistence.ts', '../project.ts', '../projection-finalize.ts',
  '../projection.ts', '../publication.ts', '../reservations.ts', '../storage.ts', '../transport.ts',
  '../../db/schema-a2.ts', '../../indexer/job-transitions.ts', '../../indexer/owner-lock.ts',
  '../../indexer/source-loader.ts', '../../indexer/vector-metadata.ts',
  '../../server/learn-persistence.ts', '../../tools/learn-legacy.ts',
  '../../vector/indexer-config.ts', '../../vector/provider-error.ts',
] as const;

describe('A2 production runtime portability', () => {
  it('has no node: imports in newly introduced production modules', async () => {
    for (const relative of NEW_PRODUCTION_MODULES) {
      const source = await Bun.file(new URL(relative, import.meta.url)).text();
      expect(source, relative).not.toMatch(/(?:from\s+|import\s*)['"]node:/);
    }
  });
});
