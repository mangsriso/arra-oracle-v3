import { createHash } from 'node:crypto';
import type { OracleDocument } from '../types.ts';

export interface ResolvedDocumentIdCollision {
  legacyId: string;
  winnerSource: string;
  remappedSource: string;
  remappedId: string;
}

export interface ResolvedDocumentIds {
  documents: OracleDocument[];
  collisions: ResolvedDocumentIdCollision[];
}

function sourceSuffix(sourceFile: string): string {
  return createHash('sha256').update(sourceFile).digest('hex').slice(0, 12);
}

/**
 * Preserve the legacy ID for one source and assign deterministic IDs to every
 * other source that the old basename-based parser made collide.
 *
 * Existing DB ownership wins so a repair does not churn the document already
 * referenced by search results. A fresh database uses lexical source order.
 */
export function resolveDocumentIdCollisions(
  input: OracleDocument[],
  existingSourcesById: ReadonlyMap<string, string> = new Map(),
): ResolvedDocumentIds {
  const byId = new Map<string, OracleDocument[]>();
  for (const document of input) {
    const group = byId.get(document.id) || [];
    group.push(document);
    byId.set(document.id, group);
  }

  const usedIds = new Set(input.map(document => document.id));
  const replacements = new Map<OracleDocument, string>();
  const collisions: ResolvedDocumentIdCollision[] = [];

  for (const [legacyId, group] of byId) {
    const sources = [...new Set(group.map(document => document.source_file))].sort();
    if (sources.length === 1) {
      if (group.length > 1) {
        throw new Error(`Duplicate document ID within one source: ${legacyId} (${sources[0]})`);
      }
      continue;
    }

    const existingSource = existingSourcesById.get(legacyId);
    const winnerSource = existingSource && sources.includes(existingSource)
      ? existingSource
      : sources[0];

    for (const document of group) {
      if (document.source_file === winnerSource) continue;
      let remappedId = `${legacyId}__src_${sourceSuffix(document.source_file)}`;
      let attempt = 1;
      while (usedIds.has(remappedId)) {
        remappedId = `${legacyId}__src_${sourceSuffix(`${document.source_file}:${attempt++}`)}`;
      }
      usedIds.add(remappedId);
      replacements.set(document, remappedId);
      collisions.push({
        legacyId,
        winnerSource,
        remappedSource: document.source_file,
        remappedId,
      });
    }
  }

  return {
    documents: input.map(document => {
      const id = replacements.get(document);
      return id ? { ...document, id } : document;
    }),
    collisions,
  };
}
