import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import migrationJournal from '../../db/migrations/meta/_journal.json' with { type: 'json' };
import { backupDatabase } from '../backup.ts';
import { verifyBackup } from '../backup-verify.ts';

function createFixture(
  dbPath: string,
  migrations: number[],
): Database {
  const db = new Database(dbPath, { create: true, strict: true });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE oracle_documents (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source_file TEXT NOT NULL,
      concepts TEXT NOT NULL,
      project TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE oracle_fts USING fts5(id UNINDEXED, content, concepts);
    CREATE TABLE __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at NUMERIC
    );
    CREATE TABLE parents (id INTEGER PRIMARY KEY);
    CREATE TABLE children (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER REFERENCES parents(id)
    );
    INSERT INTO oracle_documents
      (id, type, source_file, concepts, project, created_at, updated_at, indexed_at)
      VALUES ('doc-1', 'learning', 'one.md', '["backup"]', 'test', 10, 20, 30);
    INSERT INTO oracle_fts (id, content, concepts)
      VALUES ('doc-1', 'restore verification', 'backup');
  `);
  const insertMigration = db.prepare(
    'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)',
  );
  migrations.forEach((createdAt, index) => insertMigration.run(`hash-${index}`, createdAt));
  return db;
}

describe('backup restore verification', () => {
  let root: string;
  let dbPath: string;
  const expectedMigrations = [100, 200];
  const now = 10_000;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-verify-test-'));
    dbPath = path.join(root, 'oracle.db');
  });

  afterEach(() => {
    delete process.env.ORACLE_BACKUP_KEEP;
    delete process.env.ORACLE_BACKUP_MAX_AGE_HOURS;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function closeAt(db: Database, mtime = now): void {
    db.close();
    fs.utimesSync(dbPath, new Date(mtime), new Date(mtime));
  }

  it('passes integrity, FK, FTS identity, schema, and recovery-age gates', () => {
    closeAt(createFixture(dbPath, expectedMigrations));

    const report = verifyBackup(dbPath, {
      expectedMigrations,
      nowMs: now,
      maxAgeMs: 1_000,
      recoveryPointMs: now,
    });

    expect(report.ok).toBe(true);
    expect(report.integrity).toEqual(['ok']);
    expect(report.foreignKeyViolations).toBe(0);
    expect(report.documents).toBe(1);
    expect(report.ftsRows).toBe(1);
    expect(report.missingFromFts).toBe(0);
    expect(report.orphanedInFts).toBe(0);
    expect(report.schemaVersion).toBe(200);
    expect(report.latestDocumentUpdatedAt).toBe(20);
  });

  it('reports FK, duplicate/missing FTS, schema, and stale recovery failures together', () => {
    const db = createFixture(dbPath, [100]);
    db.exec(`
      INSERT INTO children (id, parent_id) VALUES (1, 999);
      INSERT INTO oracle_fts (id, content, concepts) VALUES ('doc-1', 'duplicate', '');
      INSERT INTO oracle_fts (id, content, concepts) VALUES ('orphan', 'orphan', '');
    `);
    closeAt(db, now - 2_000);

    const report = verifyBackup(dbPath, {
      expectedMigrations,
      nowMs: now,
      maxAgeMs: 1_000,
      recoveryPointMs: now - 2_000,
    });

    expect(report.ok).toBe(false);
    expect(report.foreignKeyViolations).toBe(1);
    expect(report.ftsRows).toBe(3);
    expect(report.orphanedInFts).toBe(1);
    expect(report.errors.join('\n')).toContain('recovery point age');
    expect(report.errors.join('\n')).toContain('FTS parity failed');
    expect(report.errors.join('\n')).toContain('schema version mismatch');
  });

  it('serializes WAL-backed rows, verifies before success, and writes private exports', () => {
    const sourceMigrations = migrationJournal.entries.map(entry => entry.when);
    const db = createFixture(dbPath, sourceMigrations);
    db.exec(`
      INSERT INTO oracle_documents
        (id, type, source_file, concepts, project, created_at, updated_at, indexed_at)
        VALUES ('doc-2', 'learning', 'two.md', '["wal"]', 'test', 40, 50, 60);
      INSERT INTO oracle_fts (id, content, concepts)
        VALUES ('doc-2', 'committed in WAL', 'wal');
    `);
    process.env.ORACLE_BACKUP_KEEP = '10';

    const result = backupDatabase(db, { dbPath });
    db.close();

    expect(result).not.toBeNull();
    expect(result!.verification.ok).toBe(true);
    expect(result!.verification.documents).toBe(2);
    for (const pathname of [result!.backupPath, result!.jsonPath, result!.csvPath]) {
      expect(fs.statSync(pathname).mode & 0o777).toBe(0o600);
    }
    const exported = JSON.parse(fs.readFileSync(result!.jsonPath, 'utf8'));
    expect(exported.count).toBe(2);
  });

  it('does not declare or export a backup with foreign-key violations', () => {
    const sourceMigrations = migrationJournal.entries.map(entry => entry.when);
    const db = createFixture(dbPath, sourceMigrations);
    db.exec('INSERT INTO children (id, parent_id) VALUES (1, 999)');

    const trashDir = path.join(root, 'trash');
    expect(() => backupDatabase(db, { dbPath }, { trashDir })).toThrow('foreign_key_check');
    db.close();

    const names = fs.readdirSync(root);
    expect(names.filter(name => name.includes('.backup-'))).toHaveLength(0);
    expect(names.filter(name => name.includes('.partial-'))).toHaveLength(0);
    expect(names.filter(name => name.includes('.export-'))).toHaveLength(0);
    const trashBatch = fs.readdirSync(trashDir)[0];
    const quarantined = fs.readdirSync(path.join(trashDir, trashBatch));
    expect(quarantined.some(name => name.includes('.partial-'))).toBe(true);
  });

  it('does not let filesystem mtime make an old recovery point appear fresh', () => {
    const oldPath = path.join(root, 'oracle.db.backup-1970-01-01T00-00-08-000Z');
    closeAt(createFixture(dbPath, expectedMigrations), now);
    fs.renameSync(dbPath, oldPath);
    fs.utimesSync(oldPath, new Date(now), new Date(now));

    const report = verifyBackup(oldPath, {
      expectedMigrations,
      nowMs: now,
      maxAgeMs: 1_000,
    });

    expect(report.ok).toBe(false);
    expect(report.backupAgeMs).toBe(2_000);
    expect(report.errors.join('\n')).toContain('recovery point age');
  });

  it('fails closed without creating a database when the scheduled path is wrong', () => {
    const missing = path.join(root, 'missing', 'oracle.db');
    const result = Bun.spawnSync({
      cmd: ['bun', 'src/indexer/backup-cli.ts', 'create'],
      cwd: path.resolve(import.meta.dir, '../../..'),
      env: {
        ...process.env,
        ORACLE_DATA_DIR: path.dirname(missing),
        ORACLE_DB_PATH: missing,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('Source database does not exist');
    expect(fs.existsSync(missing)).toBe(false);
    expect(fs.existsSync(path.dirname(missing))).toBe(false);
  });

  it('creates and independently verifies a backup through the scheduled CLI', () => {
    const sourceMigrations = migrationJournal.entries.map(entry => entry.when);
    createFixture(dbPath, sourceMigrations).close();
    const env = {
      ...process.env,
      ORACLE_DATA_DIR: root,
      ORACLE_DB_PATH: dbPath,
      ORACLE_BACKUP_KEEP: '10',
      ORACLE_BACKUP_MAX_AGE_HOURS: '30',
    };
    const cwd = path.resolve(import.meta.dir, '../../..');
    const created = Bun.spawnSync({
      cmd: ['bun', 'src/indexer/backup-cli.ts', 'create'],
      cwd,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(created.exitCode).toBe(0);
    const backup = fs.readdirSync(root)
      .find(name => name.startsWith('oracle.db.backup-'));
    expect(backup).toBeDefined();

    const verified = Bun.spawnSync({
      cmd: ['bun', 'src/indexer/backup-cli.ts', 'verify', path.join(root, backup!)],
      cwd,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(verified.exitCode).toBe(0);
    expect(verified.stdout.toString()).toContain('Backup verification OK');
  });
});
