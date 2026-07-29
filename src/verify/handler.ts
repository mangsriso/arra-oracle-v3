/**
 * Read-only knowledge index verification.
 *
 * The indexer's contract is parser output ↔ SQLite metadata/FTS content.
 * Filesystem mtime is diagnostic only: checkout/copy operations can change it
 * without changing knowledge. Non-indexer and superseded rows are reported
 * separately so preserved history is not mislabeled as actionable drift.
 */

import type { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { OracleDocument } from '../types.ts';
import { discoverProjectPsiDirs } from '../indexer/discovery.ts';
import { getAllMarkdownFiles } from '../indexer/collectors.ts';
import {
  parseLearningFile,
  parseResonanceFile,
  parseRetroFile,
} from '../indexer/parser.ts';
import {
  resolveDocumentIdCollisions,
  type ResolvedDocumentIdCollision,
} from '../indexer/document-ids.ts';

const CATEGORIES = ['resonance', 'learnings', 'retrospectives'] as const;
type Category = (typeof CATEGORIES)[number];

interface DbDocument {
  id: string;
  type: string;
  sourceFile: string;
  concepts: string;
  indexedAt: number;
  createdBy: string | null;
  supersededBy: string | null;
}

interface FtsDocument {
  id: string;
  content: string;
  concepts: string;
}

export interface VerifyDetail {
  path: string;
  reason: string;
  ids?: string[];
}

export interface VerifyResult {
  counts: {
    healthy: number;
    missing: number;
    orphaned: number;
    drifted: number;
    untracked: number;
    excluded: number;
    preserved: number;
    collisions: number;
    actionable: number;
  };
  missing: string[];
  orphaned: string[];
  drifted: string[];
  untracked: string[];
  excluded: VerifyDetail[];
  preserved: VerifyDetail[];
  resolvedCollisions: ResolvedDocumentIdCollision[];
  mtimeOnly: string[];
  details: {
    missing: VerifyDetail[];
    orphaned: VerifyDetail[];
    drifted: VerifyDetail[];
  };
  recommendation: string;
  fixedOrphans?: number;
}

interface SourceInventory {
  documents: OracleDocument[];
  allIndexableFiles: Set<string>;
  excluded: VerifyDetail[];
  untracked: string[];
  mtimes: Map<string, number>;
}

function relativeMarkdownFiles(directory: string, repoRoot: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return getAllMarkdownFiles(directory).map(file => path.relative(repoRoot, file));
}

function parseFile(category: Category, relativePath: string, content: string): OracleDocument[] {
  if (category === 'resonance') {
    return parseResonanceFile(relativePath, content, relativePath);
  }
  if (category === 'learnings') {
    return parseLearningFile(relativePath, content, relativePath);
  }
  return parseRetroFile(relativePath, content);
}

function inventorySources(repoRoot: string): SourceInventory {
  const documents: OracleDocument[] = [];
  const allIndexableFiles = new Set<string>();
  const excluded: VerifyDetail[] = [];
  const mtimes = new Map<string, number>();
  const seenProjectContentHashes = new Set<string>();
  const projectPsiDirs = discoverProjectPsiDirs(repoRoot, { quiet: true });

  for (const category of CATEGORIES) {
    const rootDirectory = path.join(repoRoot, 'ψ', 'memory', category);
    for (const relativePath of relativeMarkdownFiles(rootDirectory, repoRoot)) {
      allIndexableFiles.add(relativePath);
      const fullPath = path.join(repoRoot, relativePath);
      mtimes.set(relativePath, fs.statSync(fullPath).mtimeMs);
      const parsed = parseFile(category, relativePath, fs.readFileSync(fullPath, 'utf8'));
      if (parsed.length === 0) {
        excluded.push({ path: relativePath, reason: 'no-indexable-sections' });
      } else {
        documents.push(...parsed);
      }
    }

    for (const psiDir of projectPsiDirs) {
      const projectDirectory = path.join(psiDir, 'memory', category);
      for (const relativePath of relativeMarkdownFiles(projectDirectory, repoRoot)) {
        allIndexableFiles.add(relativePath);
        const fullPath = path.join(repoRoot, relativePath);
        mtimes.set(relativePath, fs.statSync(fullPath).mtimeMs);
        const content = fs.readFileSync(fullPath, 'utf8');
        const contentHash = Bun.hash(content).toString(36);
        if (seenProjectContentHashes.has(contentHash)) {
          excluded.push({ path: relativePath, reason: 'duplicate-project-content' });
          continue;
        }
        seenProjectContentHashes.add(contentHash);
        const parsed = parseFile(category, relativePath, content);
        if (parsed.length === 0) {
          excluded.push({ path: relativePath, reason: 'no-indexable-sections' });
        } else {
          documents.push(...parsed);
        }
      }
    }
  }

  // _universal is a vault/sync layout, not an OracleIndexer input. The old
  // verifier scanned it anyway and produced 216 false "drifted" files.
  for (const category of CATEGORIES) {
    const directory = path.join(repoRoot, '_universal', 'ψ', 'memory', category);
    for (const relativePath of relativeMarkdownFiles(directory, repoRoot)) {
      excluded.push({ path: relativePath, reason: 'universal-mirror-not-indexed' });
    }
  }

  const untracked = relativeMarkdownFiles(path.join(repoRoot, 'ψ', 'inbox'), repoRoot);
  return { documents, allIndexableFiles, excluded, untracked, mtimes };
}

function loadDbDocuments(sqlite: Database, type?: string): DbDocument[] {
  const columns = new Set(
    (sqlite.query('PRAGMA table_info(oracle_documents)').all() as Array<{ name: string }>)
      .map(column => column.name),
  );
  const createdBy = columns.has('created_by') ? 'created_by' : 'NULL';
  const supersededBy = columns.has('superseded_by') ? 'superseded_by' : 'NULL';
  const params: string[] = [];
  let where = '';
  if (type && type !== 'all') {
    where = 'WHERE type = ?';
    params.push(type);
  }
  return sqlite.query(`
    SELECT id, type, source_file AS sourceFile, concepts,
           indexed_at AS indexedAt, ${createdBy} AS createdBy,
           ${supersededBy} AS supersededBy
    FROM oracle_documents
    ${where}
  `).all(...params) as DbDocument[];
}

function loadFtsDocuments(sqlite: Database): Map<string, FtsDocument[]> {
  const rows = sqlite.query('SELECT id, content, concepts FROM oracle_fts').all() as FtsDocument[];
  const byId = new Map<string, FtsDocument[]>();
  for (const row of rows) {
    const group = byId.get(row.id) || [];
    group.push(row);
    byId.set(row.id, group);
  }
  return byId;
}

function addBySource<T extends { sourceFile: string }>(rows: T[]): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const group = result.get(row.sourceFile) || [];
    group.push(row);
    result.set(row.sourceFile, group);
  }
  return result;
}

function conceptsEqual(expected: string[], actual: string): boolean {
  try {
    return JSON.stringify(expected) === JSON.stringify(JSON.parse(actual));
  } catch {
    return false;
  }
}

function uniqueDetails(details: VerifyDetail[]): VerifyDetail[] {
  const seen = new Set<string>();
  return details.filter(detail => {
    const key = `${detail.path}\0${detail.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function verifyKnowledgeBase(opts: {
  sqlite: Database;
  check?: boolean;
  type?: string;
  repoRoot: string;
}): VerifyResult {
  const { sqlite, check = true, type, repoRoot } = opts;
  const inventory = inventorySources(repoRoot);
  const dbRows = loadDbDocuments(sqlite, type);
  const indexRows = dbRows.filter(row => row.createdBy === 'indexer' || row.createdBy === null);
  const durableRows = dbRows.filter(row => row.createdBy !== 'indexer' && row.createdBy !== null);
  const indexById = new Map(indexRows.map(row => [row.id, row]));
  const indexBySource = addBySource(indexRows);
  const durableBySource = addBySource(durableRows);
  const ftsById = loadFtsDocuments(sqlite);
  const expectedDocuments = type && type !== 'all'
    ? inventory.documents.filter(document => document.type === type)
    : inventory.documents;

  const resolved = resolveDocumentIdCollisions(
    expectedDocuments,
    new Map(indexRows.map(row => [row.id, row.sourceFile])),
  );
  const expectedBySource = new Map<string, OracleDocument[]>();
  for (const document of resolved.documents) {
    const group = expectedBySource.get(document.source_file) || [];
    group.push(document);
    expectedBySource.set(document.source_file, group);
  }

  const healthy: string[] = [];
  const missingDetails: VerifyDetail[] = [];
  const driftedDetails: VerifyDetail[] = [];
  const orphanedDetails: VerifyDetail[] = [];
  const preserved: VerifyDetail[] = [];
  const excluded = [...inventory.excluded];
  const mtimeOnly: string[] = [];

  for (const [sourceFile, expectedDocuments] of expectedBySource) {
    const actualRows = indexBySource.get(sourceFile) || [];
    if (actualRows.length === 0) {
      missingDetails.push({
        path: sourceFile,
        reason: 'no-indexer-row',
        ids: expectedDocuments.map(document => document.id),
      });
      continue;
    }

    const expectedIds = new Set(expectedDocuments.map(document => document.id));
    const actualIds = new Set(actualRows.map(row => row.id));
    const reasons: string[] = [];
    const missingIds = [...expectedIds].filter(id => !actualIds.has(id));
    const staleIds = [...actualIds].filter(id => !expectedIds.has(id));
    if (missingIds.length > 0) reasons.push(`missing-ids:${missingIds.length}`);
    if (staleIds.length > 0) reasons.push(`stale-ids:${staleIds.length}`);

    for (const document of expectedDocuments) {
      const row = indexById.get(document.id);
      if (!row || row.sourceFile !== sourceFile) continue;
      if (row.type !== document.type) reasons.push(`type:${document.id}`);
      if (!conceptsEqual(document.concepts, row.concepts)) reasons.push(`concepts:${document.id}`);
      const ftsRows = ftsById.get(document.id) || [];
      if (ftsRows.length !== 1) {
        reasons.push(`fts-cardinality:${document.id}:${ftsRows.length}`);
      } else if (
        ftsRows[0].content !== document.content
        || ftsRows[0].concepts !== document.concepts.join(' ')
      ) {
        reasons.push(`fts-content:${document.id}`);
      }
    }

    if (reasons.length > 0) {
      driftedDetails.push({ path: sourceFile, reason: reasons.join(','), ids: [...expectedIds] });
      continue;
    }

    healthy.push(sourceFile);
    const latestIndexedAt = Math.max(...actualRows.map(row => Number(row.indexedAt)));
    if ((inventory.mtimes.get(sourceFile) || 0) > latestIndexedAt) {
      mtimeOnly.push(sourceFile);
    }
  }

  // Indexer rows whose files are outside the current parser output are either
  // stale (file still in index scope), out-of-scope history, or true orphans.
  for (const [sourceFile, rows] of indexBySource) {
    if (expectedBySource.has(sourceFile)) continue;
    if (inventory.allIndexableFiles.has(sourceFile)) {
      driftedDetails.push({
        path: sourceFile,
        reason: 'indexer-rows-for-excluded-or-empty-file',
        ids: rows.map(row => row.id),
      });
    } else if (fs.existsSync(path.join(repoRoot, sourceFile))) {
      excluded.push({ path: sourceFile, reason: 'db-source-outside-indexer-scope' });
    } else {
      orphanedDetails.push({
        path: sourceFile,
        reason: 'indexer-source-missing-from-disk',
        ids: rows.map(row => row.id),
      });
    }
  }

  // arra_learn/manual rows are durable records, not indexer output. Missing
  // superseded files are expected history under "Nothing is Deleted".
  for (const [sourceFile, rows] of durableBySource) {
    if (expectedBySource.has(sourceFile) || inventory.allIndexableFiles.has(sourceFile)) continue;
    if (fs.existsSync(path.join(repoRoot, sourceFile))) {
      excluded.push({ path: sourceFile, reason: 'durable-source-outside-indexer-scope' });
    } else if (rows.every(row => row.supersededBy !== null)) {
      preserved.push({
        path: sourceFile,
        reason: 'superseded-durable-history',
        ids: rows.map(row => row.id),
      });
    } else {
      orphanedDetails.push({
        path: sourceFile,
        reason: 'unsuperseded-durable-source-missing',
        ids: rows.map(row => row.id),
      });
    }
  }

  const missing = uniqueDetails(missingDetails);
  const drifted = uniqueDetails(driftedDetails);
  const orphaned = uniqueDetails(orphanedDetails);
  const finalExcluded = uniqueDetails(excluded);
  const finalPreserved = uniqueDetails(preserved);

  let fixedOrphans = 0;
  if (!check) {
    const update = sqlite.prepare(`
      UPDATE oracle_documents
      SET superseded_by = '_verified_orphan',
          superseded_at = ?,
          superseded_reason = 'File missing from disk (arra_verify)'
      WHERE id = ? AND superseded_by IS NULL
    `);
    const now = Date.now();
    for (const detail of orphaned) {
      for (const id of detail.ids || []) {
        fixedOrphans += Number(update.run(now, id).changes);
      }
    }
  }

  const actionable = missing.length + orphaned.length + drifted.length;
  const recommendation = actionable === 0
    ? 'Knowledge file index is healthy. Vector parity is a separate invariant.'
    : `Run \`bun run index\` after review to reconcile ${actionable} file issue(s), `
      + 'then run the model backfill separately to restore documents == vectors.';

  return {
    counts: {
      healthy: healthy.length,
      missing: missing.length,
      orphaned: orphaned.length,
      drifted: drifted.length,
      untracked: inventory.untracked.length,
      excluded: finalExcluded.length,
      preserved: finalPreserved.length,
      collisions: new Set(resolved.collisions.map(item => item.remappedSource)).size,
      actionable,
    },
    missing: missing.map(detail => detail.path),
    orphaned: orphaned.map(detail => detail.path),
    drifted: drifted.map(detail => detail.path),
    untracked: inventory.untracked,
    excluded: finalExcluded,
    preserved: finalPreserved,
    resolvedCollisions: resolved.collisions,
    mtimeOnly,
    details: { missing, orphaned, drifted },
    recommendation,
    ...(fixedOrphans > 0 ? { fixedOrphans } : {}),
  };
}
