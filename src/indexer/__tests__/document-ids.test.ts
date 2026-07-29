import { describe, expect, test } from 'bun:test';
import type { OracleDocument } from '../../types.ts';
import { resolveDocumentIdCollisions } from '../document-ids.ts';

function doc(source: string, id = 'retro_same_0'): OracleDocument {
  return {
    id,
    type: 'retro',
    source_file: source,
    content: source,
    concepts: [],
    created_at: 1,
    updated_at: 1,
  };
}

describe('document ID collision resolver', () => {
  test('preserves the source that owns the legacy ID in the existing DB', () => {
    const oldSource = 'github.com/org/old/ψ/memory/retrospectives/same.md';
    const newSource = 'github.com/org/new/ψ/memory/retrospectives/same.md';
    const result = resolveDocumentIdCollisions(
      [doc(newSource), doc(oldSource)],
      new Map([['retro_same_0', oldSource]]),
    );

    expect(result.documents.find(item => item.source_file === oldSource)?.id).toBe('retro_same_0');
    expect(result.documents.find(item => item.source_file === newSource)?.id)
      .toMatch(/^retro_same_0__src_[a-f0-9]{12}$/);
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0].winnerSource).toBe(oldSource);
  });

  test('uses lexical source order deterministically for a fresh DB', () => {
    const sources = ['z/source.md', 'a/source.md'];
    const first = resolveDocumentIdCollisions(sources.map(source => doc(source)));
    const second = resolveDocumentIdCollisions([...sources].reverse().map(source => doc(source)));

    const normalized = (result: typeof first) => result.documents
      .map(item => [item.source_file, item.id])
      .sort(([a], [b]) => a.localeCompare(b));
    expect(normalized(first)).toEqual(normalized(second));
    expect(first.documents.find(item => item.source_file === 'a/source.md')?.id).toBe('retro_same_0');
  });

  test('rejects duplicate IDs emitted twice for the same source', () => {
    expect(() => resolveDocumentIdCollisions([doc('same.md'), doc('same.md')]))
      .toThrow(/Duplicate document ID within one source/);
  });
});
