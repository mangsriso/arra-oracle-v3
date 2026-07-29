import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  _backupFamilyForTest,
  rotateBackupFamilies,
} from '../backup-retention.ts';

describe('unified backup retention', () => {
  let root: string;
  let dataDir: string;
  let trashDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-retention-test-'));
    dataDir = path.join(root, 'data');
    trashDir = path.join(root, 'trash');
    fs.mkdirSync(dataDir);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function artifact(name: string, mtimeMs: number, directory = false): void {
    const pathname = path.join(dataDir, name);
    if (directory) fs.mkdirSync(pathname);
    else fs.writeFileSync(pathname, name);
    fs.utimesSync(pathname, new Date(mtimeMs), new Date(mtimeMs));
  }

  it('recognizes every supported historical family', () => {
    expect(_backupFamilyForTest('oracle.db.backup-1')).toBe('oracle.db.backup');
    expect(_backupFamilyForTest('oracle.db.export-1.json')).toBe('oracle.db.export.json');
    expect(_backupFamilyForTest('oracle.db.export-1.csv')).toBe('oracle.db.export.csv');
    expect(_backupFamilyForTest('oracle.db.bak-1')).toBe('oracle.db.bak');
    expect(_backupFamilyForTest('oracle.db.before-1')).toBe('oracle.db.before');
    expect(_backupFamilyForTest('oracle.db.checkpoint-1')).toBe('oracle.db.checkpoint');
    expect(_backupFamilyForTest('lancedb.backup-1')).toBe('lancedb.backup');
    expect(_backupFamilyForTest('pre-fix-1')).toBe('pre-fix');
    expect(_backupFamilyForTest('oracle.db')).toBeNull();
  });

  it('keeps the newest item per family and moves older files/directories to trash', () => {
    const families: Array<[string, string, boolean?]> = [
      ['oracle.db.backup-old', 'oracle.db.backup-new'],
      ['oracle.db.export-old.json', 'oracle.db.export-new.json'],
      ['oracle.db.export-old.csv', 'oracle.db.export-new.csv'],
      ['oracle.db.bak-old', 'oracle.db.bak-new'],
      ['oracle.db.before-old', 'oracle.db.before-new'],
      ['oracle.db.checkpoint-old', 'oracle.db.checkpoint-new'],
      ['lancedb.backup-old', 'lancedb.backup-new', true],
      ['pre-fix-old', 'pre-fix-new', true],
    ];
    for (const [oldName, newName, directory] of families) {
      artifact(oldName, 1_000, directory);
      artifact(newName, 2_000, directory);
    }
    artifact('unrelated.data', 500);

    const moves = rotateBackupFamilies(dataDir, { keep: 1, trashDir });

    expect(moves).toHaveLength(families.length);
    for (const [oldName, newName] of families) {
      expect(fs.existsSync(path.join(dataDir, oldName))).toBe(false);
      const move = moves.find(item => path.basename(item.source) === oldName);
      expect(move).toBeDefined();
      expect(fs.existsSync(move!.destination)).toBe(true);
      expect(fs.existsSync(path.join(dataDir, newName))).toBe(true);
    }
    expect(fs.existsSync(path.join(dataDir, 'unrelated.data'))).toBe(true);
  });

  it('uses a collision-safe trash name without overwriting history', () => {
    artifact('pre-fix-old', 1_000);
    artifact('pre-fix-new', 2_000);
    fs.mkdirSync(trashDir);
    fs.writeFileSync(path.join(trashDir, 'pre-fix-old'), 'existing');

    const [move] = rotateBackupFamilies(dataDir, { keep: 1, trashDir });

    expect(fs.readFileSync(path.join(trashDir, 'pre-fix-old'), 'utf8')).toBe('existing');
    expect(path.dirname(move.destination)).not.toBe(trashDir);
    expect(path.basename(move.destination)).toBe('pre-fix-old');
    expect(fs.readFileSync(move.destination, 'utf8')).toBe('pre-fix-old');
  });

  it('verifies a cross-device copy before removing the source', () => {
    artifact('oracle.db.backup-old', 1_000);
    artifact('oracle.db.backup-new', 2_000);
    const crossDeviceRename = () => {
      const error: NodeJS.ErrnoException = new Error('cross-device');
      error.code = 'EXDEV';
      throw error;
    };

    const [move] = rotateBackupFamilies(dataDir, {
      keep: 1,
      trashDir,
      rename: crossDeviceRename,
    });

    expect(fs.existsSync(path.join(dataDir, 'oracle.db.backup-old'))).toBe(false);
    expect(fs.readFileSync(move.destination, 'utf8')).toBe('oracle.db.backup-old');
  });

  it('rejects invalid retention counts before moving anything', () => {
    artifact('oracle.db.backup-old', 1_000);
    expect(() => rotateBackupFamilies(dataDir, { keep: -1, trashDir })).toThrow();
    expect(fs.existsSync(path.join(dataDir, 'oracle.db.backup-old'))).toBe(true);
  });
});
