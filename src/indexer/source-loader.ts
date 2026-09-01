import type Database from 'bun:sqlite';
import type { EnqueuedJob } from './jobs.ts';
import type { DocumentLoadResult } from './worker.ts';
import { learningVectorMetadata } from './vector-metadata.ts';

interface ReservationRow {
  source_file: string; storage_root: string; content_hash: string | null; state: string;
}

function commandText(args: string[]): string | null {
  const result = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'ignore' });
  return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : null;
}

function physicallyContained(root: string, candidate: string): string | null {
  const physicalRoot = commandText(['realpath', '--', root]);
  const physicalFile = commandText(['realpath', '--', candidate]);
  if (!physicalRoot || !physicalFile) return null;
  return physicalFile === physicalRoot || physicalFile.startsWith(`${physicalRoot}/`)
    ? physicalFile : null;
}

function legacySourcePath(root: string, vaultRoot: string | null, sourceFile: string): string | null {
  if (sourceFile.startsWith('/') || sourceFile.split('/').includes('..')) return null;
  const base = sourceFile.startsWith('ψ/') ? root : (vaultRoot || root);
  const candidate = `${base.replace(/\/+$/, '')}/${sourceFile.replace(/^\/+/, '')}`;
  return physicallyContained(base, candidate);
}

function hash(content: string): string {
  return new Bun.CryptoHasher('sha256').update(content).digest('hex');
}

function concepts(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function makeDocumentLoader(input: {
  db: Database;
  repoRoot: string;
  vaultRoot?: string | null;
  metadataSchemaVersion: number;
}): (job: EnqueuedJob) => Promise<DocumentLoadResult> {
  return async (job) => {
    const document = input.db.query<{
      source_file: string; concepts: string; project: string | null;
      origin: string | null; created_at: number; updated_at: number;
    }, [string]>(`
      SELECT source_file, concepts, project, origin, created_at, updated_at
      FROM oracle_documents WHERE id = ?
    `).get(job.docId);
    if (!document) return { kind: 'missing' };
    let reservation: ReservationRow | null = null;
    try {
      reservation = input.db.query<ReservationRow, [string]>(`
        SELECT source_file, storage_root, content_hash, state
        FROM learn_reservations_v2 WHERE doc_id = ?
      `).get(job.docId);
    } catch (error) {
      if (!String(error).includes('no such table: learn_reservations_v2')) throw error;
    }
    let absolute: string | null;
    if (reservation) {
      if (reservation.state !== 'committed'
        || reservation.source_file !== document.source_file
        || reservation.content_hash !== job.contentHash) return { kind: 'content_mismatch' };
      const filename = reservation.source_file.split('/').at(-1);
      if (!filename || filename === '.' || filename === '..') return { kind: 'missing' };
      absolute = physicallyContained(
        reservation.storage_root,
        `${reservation.storage_root.replace(/\/+$/, '')}/${filename}`,
      );
    } else {
      absolute = legacySourcePath(input.repoRoot, input.vaultRoot ?? null, document.source_file);
    }
    if (!absolute) return { kind: 'missing' };
    const file = Bun.file(absolute);
    if (!await file.exists()) return { kind: 'missing' };
    const text = await file.text();
    if (hash(text) !== job.contentHash) return { kind: 'content_mismatch' };
    const fts = input.db.query<{ content: string }, [string]>(`
      SELECT content FROM oracle_fts WHERE id = ?
    `).get(job.docId);
    if (!fts || fts.content !== text) return { kind: 'fts_mismatch' };
    return {
      kind: 'ready',
      text,
      metadata: learningVectorMetadata({
        sourceFile: document.source_file,
        concepts: concepts(document.concepts),
        project: document.project,
        origin: document.origin,
        createdAt: document.created_at,
        updatedAt: document.updated_at,
        contentHash: job.contentHash,
        modelKey: job.modelKey,
        indexRevision: job.indexRevision,
        metadataSchemaVersion: input.metadataSchemaVersion,
      }),
    };
  };
}
