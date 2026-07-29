import fs from 'fs';
import { Database } from 'bun:sqlite';
import migrationJournal from '../db/migrations/meta/_journal.json' with { type: 'json' };

export const DEFAULT_BACKUP_MAX_AGE_MS = 30 * 60 * 60 * 1000;
const CLOCK_SKEW_TOLERANCE_MS = 5_000;
const EXPECTED_MIGRATIONS = migrationJournal.entries.map(entry => entry.when);

export interface BackupVerificationOptions {
  nowMs?: number;
  maxAgeMs?: number;
  recoveryPointMs?: number;
  expectedMigrations?: number[];
}

export interface BackupVerificationReport {
  ok: boolean;
  path: string;
  errors: string[];
  integrity: string[];
  foreignKeyViolations: number;
  documents: number;
  ftsRows: number;
  ftsDistinctIds: number;
  missingFromFts: number;
  orphanedInFts: number;
  schemaVersion: number | null;
  expectedSchemaVersion: number | null;
  backupAgeMs: number;
  latestDocumentUpdatedAt: number | null;
}

function scalar(
  db: Database,
  sql: string,
  field: string,
): number {
  const row = db.query(sql).get() as Record<string, number> | null;
  if (!row || typeof row[field] !== 'number') {
    throw new Error(`Query did not return numeric ${field}`);
  }
  return row[field];
}

function recoveryPointFromName(backupPath: string): number | null {
  const match = backupPath.match(
    /\.(?:backup|partial)-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second, millisecond] = match;
  const value = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(millisecond),
  );
  const canonical = new Date(value).toISOString().replace(/[:.]/g, '-');
  const encoded = `${year}-${month}-${day}T${hour}-${minute}-${second}-${millisecond}Z`;
  return canonical === encoded ? value : null;
}

export function verifyBackup(
  backupPath: string,
  options: BackupVerificationOptions = {},
): BackupVerificationReport {
  const errors: string[] = [];
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_BACKUP_MAX_AGE_MS;
  const expectedMigrations = options.expectedMigrations ?? EXPECTED_MIGRATIONS;
  const expectedSchemaVersion = expectedMigrations.at(-1) ?? null;

  let backupAgeMs = Number.POSITIVE_INFINITY;
  try {
    fs.statSync(backupPath);
    const recoveryPointMs = options.recoveryPointMs ?? recoveryPointFromName(backupPath);
    if (recoveryPointMs === null || !Number.isFinite(recoveryPointMs)) {
      errors.push(
        'recovery point age unavailable: use a canonical .backup-TIMESTAMP filename',
      );
    } else {
      backupAgeMs = nowMs - recoveryPointMs;
      if (backupAgeMs < -CLOCK_SKEW_TOLERANCE_MS) {
        errors.push('recovery point is dated in the future');
      }
      backupAgeMs = Math.max(0, backupAgeMs);
      if (backupAgeMs > maxAgeMs) {
        errors.push(`recovery point age ${backupAgeMs}ms exceeds ${maxAgeMs}ms`);
      }
    }
  } catch (error) {
    errors.push(`recovery point stat failed: ${error instanceof Error ? error.message : error}`);
  }

  let integrity: string[] = [];
  let foreignKeyViolations = -1;
  let documents = -1;
  let ftsRows = -1;
  let ftsDistinctIds = -1;
  let missingFromFts = -1;
  let orphanedInFts = -1;
  let schemaVersion: number | null = null;
  let latestDocumentUpdatedAt: number | null = null;
  let db: Database | null = null;

  try {
    db = new Database(backupPath, { readonly: true, strict: true });

    integrity = (db.query('PRAGMA integrity_check').all() as Array<Record<string, string>>)
      .map(row => String(Object.values(row)[0]));
    if (integrity.length !== 1 || integrity[0] !== 'ok') {
      errors.push(`integrity_check failed: ${integrity.join(', ') || 'no result'}`);
    }

    foreignKeyViolations = db.query('PRAGMA foreign_key_check').all().length;
    if (foreignKeyViolations !== 0) {
      errors.push(`foreign_key_check found ${foreignKeyViolations} violation(s)`);
    }

    documents = scalar(db, 'SELECT COUNT(*) AS count FROM oracle_documents', 'count');
    ftsRows = scalar(db, 'SELECT COUNT(*) AS count FROM oracle_fts', 'count');
    ftsDistinctIds = scalar(db, 'SELECT COUNT(DISTINCT id) AS count FROM oracle_fts', 'count');
    missingFromFts = scalar(
      db,
      'SELECT COUNT(*) AS count FROM (SELECT id FROM oracle_documents EXCEPT SELECT id FROM oracle_fts)',
      'count',
    );
    orphanedInFts = scalar(
      db,
      'SELECT COUNT(*) AS count FROM (SELECT id FROM oracle_fts EXCEPT SELECT id FROM oracle_documents)',
      'count',
    );
    if (
      documents !== ftsRows ||
      documents !== ftsDistinctIds ||
      missingFromFts !== 0 ||
      orphanedInFts !== 0
    ) {
      errors.push(
        `FTS parity failed: documents=${documents}, rows=${ftsRows}, ` +
        `distinct=${ftsDistinctIds}, missing=${missingFromFts}, orphaned=${orphanedInFts}`,
      );
    }

    const migrationRows = db
      .query('SELECT created_at FROM __drizzle_migrations ORDER BY created_at')
      .all() as Array<{ created_at: number }>;
    const actualMigrations = migrationRows.map(row => row.created_at);
    schemaVersion = actualMigrations.at(-1) ?? null;
    if (
      actualMigrations.length !== expectedMigrations.length ||
      actualMigrations.some((value, index) => value !== expectedMigrations[index])
    ) {
      errors.push(
        `schema version mismatch: actual=${schemaVersion ?? 'none'} ` +
        `(${actualMigrations.length} migrations), expected=${expectedSchemaVersion ?? 'none'} ` +
        `(${expectedMigrations.length} migrations)`,
      );
    }

    const latest = db.query(
      'SELECT MAX(updated_at) AS value FROM oracle_documents',
    ).get() as { value: number | null } | null;
    latestDocumentUpdatedAt = latest?.value ?? null;
  } catch (error) {
    errors.push(`restore verification query failed: ${error instanceof Error ? error.message : error}`);
  } finally {
    db?.close();
  }

  return {
    ok: errors.length === 0,
    path: backupPath,
    errors,
    integrity,
    foreignKeyViolations,
    documents,
    ftsRows,
    ftsDistinctIds,
    missingFromFts,
    orphanedInFts,
    schemaVersion,
    expectedSchemaVersion,
    backupAgeMs,
    latestDocumentUpdatedAt,
  };
}

export function assertBackupRestorable(
  backupPath: string,
  options: BackupVerificationOptions = {},
): BackupVerificationReport {
  const report = verifyBackup(backupPath, options);
  if (!report.ok) {
    throw new Error(`Backup restore verification failed:\n- ${report.errors.join('\n- ')}`);
  }
  return report;
}
