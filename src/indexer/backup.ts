/**
 * Consistent, restore-verified database backup before destructive operations.
 * Philosophy: "Nothing is Deleted" — old artifacts move to ~/.trash.
 */

import fs from 'fs';
import path from 'path';
import { Database } from 'bun:sqlite';
import type { IndexerConfig } from '../types.ts';
import { acquireLock, releaseLock } from './backup-lock.ts';
import {
  rotateBackupFamilies,
  trashBackupArtifact,
} from './backup-retention.ts';
import {
  assertBackupRestorable,
  DEFAULT_BACKUP_MAX_AGE_MS,
  type BackupVerificationReport,
} from './backup-verify.ts';

const DEFAULT_BACKUP_KEEP = 10;

type BackupConfig = Pick<IndexerConfig, 'dbPath'>;
type ExportDocument = {
  id: string;
  type: string;
  source_file: string;
  concepts: string;
  project: string | null;
  content: string;
};

export interface BackupResult {
  backupPath: string;
  jsonPath: string;
  csvPath: string;
  verification: BackupVerificationReport;
}

export interface BackupOptions {
  trashDir?: string;
}

export { acquireLock, releaseLock } from './backup-lock.ts';
export { rotateBackupFamilies } from './backup-retention.ts';
export { assertBackupRestorable, verifyBackup } from './backup-verify.ts';

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function maxBackupAgeMs(): number {
  const hours = Number(process.env.ORACLE_BACKUP_MAX_AGE_HOURS);
  return Number.isFinite(hours) && hours > 0
    ? hours * 60 * 60 * 1000
    : DEFAULT_BACKUP_MAX_AGE_MS;
}

function writePrivate(pathname: string, contents: string | Uint8Array): void {
  fs.writeFileSync(pathname, contents, { flag: 'wx', mode: 0o600 });
  fs.chmodSync(pathname, 0o600);
}

function makeSnapshotStandalone(backupPath: string): void {
  const backup = new Database(backupPath, { strict: true });
  try {
    backup.exec('PRAGMA journal_mode = DELETE');
  } finally {
    backup.close();
  }
  fs.chmodSync(backupPath, 0o600);
}

function readExportDocuments(backupPath: string): ExportDocument[] {
  const backup = new Database(backupPath, { readonly: true, strict: true });
  try {
    return backup.query(`
      SELECT d.id, d.type, d.source_file, d.concepts, d.project, f.content
      FROM oracle_documents d
      JOIN oracle_fts f ON d.id = f.id
      ORDER BY d.id
    `).all() as ExportDocument[];
  } finally {
    backup.close();
  }
}

function escapeCsv(value: unknown): string {
  const text = String(value ?? '');
  if (text.includes('"') || text.includes(',') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * Create and verify a backup set. Returns null only when another live owner
 * holds the lock. Verification failure throws before exports or retention.
 */
export function backupDatabase(
  sqlite: Database,
  config: BackupConfig,
  options: BackupOptions = {},
): BackupResult | null {
  const lockPath = `${config.dbPath}.backup.lock`;
  if (!acquireLock(lockPath)) {
    console.log('⏳ Backup already in progress (locked by a live owner) — skipping');
    return null;
  }

  try {
    return backupDatabaseUnsafe(sqlite, config, options);
  } finally {
    releaseLock(lockPath);
  }
}

function backupDatabaseUnsafe(
  sqlite: Database,
  config: BackupConfig,
  options: BackupOptions,
): BackupResult {
  const recoveryPointMs = Date.now();
  const timestamp = new Date(recoveryPointMs).toISOString().replace(/[:.]/g, '-');
  const partialPath = `${config.dbPath}.partial-${timestamp}`;
  const backupPath = `${config.dbPath}.backup-${timestamp}`;
  const jsonPath = `${config.dbPath}.export-${timestamp}.json`;
  const csvPath = `${config.dbPath}.export-${timestamp}.csv`;

  // sqlite3_serialize reads the connection's current committed view, including
  // WAL-backed pages, without forcing a checkpoint against the live server.
  writePrivate(partialPath, sqlite.serialize());
  makeSnapshotStandalone(partialPath);
  let verification: BackupVerificationReport;
  try {
    verification = assertBackupRestorable(partialPath, {
      maxAgeMs: maxBackupAgeMs(),
      recoveryPointMs,
    });
  } catch (error) {
    try {
      const quarantined = trashBackupArtifact(partialPath, options.trashDir);
      console.warn(`⚠️ Failed backup quarantined: ${quarantined}`);
    } catch (quarantineError) {
      throw new AggregateError(
        [error, quarantineError],
        'Backup verification and quarantine both failed',
      );
    }
    throw error;
  }
  fs.renameSync(partialPath, backupPath);
  verification.path = backupPath;

  const docs = readExportDocuments(backupPath);
  const exportedAt = new Date().toISOString();
  const exportData = {
    exported_at: exportedAt,
    count: docs.length,
    documents: docs.map(doc => ({
      ...doc,
      concepts: JSON.parse(doc.concepts || '[]'),
    })),
  };
  writePrivate(jsonPath, JSON.stringify(exportData, null, 2));

  const header = 'id,type,source_file,concepts,project,content';
  const rows = docs.map(doc =>
    [doc.id, doc.type, doc.source_file, doc.concepts, doc.project, doc.content]
      .map(escapeCsv)
      .join(','),
  );
  writePrivate(csvPath, [header, ...rows].join('\n'));

  console.log(`📦 Verified DB backup: ${backupPath} (${verification.documents} docs)`);
  console.log(`📄 JSON export: ${jsonPath} (${docs.length} docs)`);
  console.log(`📊 CSV export: ${csvPath} (${docs.length} rows)`);

  const keep = nonNegativeInteger(process.env.ORACLE_BACKUP_KEEP, DEFAULT_BACKUP_KEEP);
  rotateBackupFamilies(path.dirname(config.dbPath), {
    keep,
    ...(options.trashDir && { trashDir: options.trashDir }),
  });
  return { backupPath, jsonPath, csvPath, verification };
}
