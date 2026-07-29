#!/usr/bin/env bun

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Database } from 'bun:sqlite';
import { ORACLE_DATA_DIR_NAME, ORACLE_DB_FILE } from '../const.ts';
import { backupDatabase } from './backup.ts';
import {
  DEFAULT_BACKUP_MAX_AGE_MS,
  verifyBackup,
} from './backup-verify.ts';

const dataDir = process.env.ORACLE_DATA_DIR || path.join(os.homedir(), ORACLE_DATA_DIR_NAME);
const DB_PATH = process.env.ORACLE_DB_PATH || path.join(dataDir, ORACLE_DB_FILE);

function maxAgeMs(): number {
  const hours = Number(process.env.ORACLE_BACKUP_MAX_AGE_HOURS);
  return Number.isFinite(hours) && hours > 0
    ? hours * 60 * 60 * 1000
    : DEFAULT_BACKUP_MAX_AGE_MS;
}

function printVerification(pathname: string): boolean {
  const report = verifyBackup(pathname, { maxAgeMs: maxAgeMs() });
  if (!report.ok) {
    console.error(`Backup verification FAILED: ${pathname}`);
    for (const error of report.errors) console.error(`- ${error}`);
    return false;
  }
  console.log(
    `Backup verification OK: ${pathname}\n` +
    `documents=${report.documents} fts=${report.ftsRows} fk=0 ` +
    `schema=${report.schemaVersion} age_ms=${Math.round(report.backupAgeMs)} ` +
    `latest_document_updated_at=${report.latestDocumentUpdatedAt ?? 'none'}`,
  );
  return true;
}

function usage(): never {
  console.error(
    'Usage:\n' +
    '  bun run backup:create\n' +
    '  bun run backup:verify -- /path/to/oracle.db.backup-TIMESTAMP',
  );
  process.exit(2);
}

const command = process.argv[2];
if (command === 'create') {
  let source: fs.Stats;
  try {
    source = fs.statSync(DB_PATH);
  } catch {
    console.error(`Source database does not exist: ${DB_PATH}`);
    process.exit(1);
  }
  if (!source.isFile()) {
    console.error(`Source database is not a regular file: ${DB_PATH}`);
    process.exit(1);
  }
  const sqlite = new Database(DB_PATH, { readonly: true, strict: true });
  try {
    const result = backupDatabase(sqlite, { dbPath: DB_PATH });
    if (!result) {
      console.error('Backup skipped because another live owner holds the lock');
      process.exitCode = 75;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    sqlite.close();
  }
} else if (command === 'verify') {
  const backupPath = process.argv[3];
  if (!backupPath) usage();
  if (!printVerification(backupPath)) process.exitCode = 1;
} else {
  usage();
}
