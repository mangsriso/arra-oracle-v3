import { afterEach, describe, expect, it } from 'bun:test';
import Database from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeLockHolders, parseWriteLocks } from '../lock-holders.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('lock holder diagnostics', () => {
  it('keeps only WRITE locks on the database files, minus the excluded pid', () => {
    const inodes = new Map([['111', 'db' as const], ['333', 'shm' as const]]);
    const sample = [
      '1: POSIX  ADVISORY  READ 500 fc:00:333 128 128',
      '2: POSIX  ADVISORY  WRITE 600 fc:00:333 120 120',
      '3: POSIX  ADVISORY  WRITE 700 fc:00:999 0 EOF',
      '4: POSIX  ADVISORY  WRITE 42 fc:00:111 1073741824 1073741824',
      '5: FLOCK  ADVISORY  WRITE 601 fc:00:333 0 EOF',
      '',
    ].join('\n');
    expect(parseWriteLocks(sample, inodes, 42)).toEqual([
      { pid: 600, file: 'shm', range: '120-120' },
      { pid: 601, file: 'shm', range: '0-EOF' },
    ]);
  });

  it.skipIf(process.platform !== 'linux')('names a real connection that holds the write lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arra-lockholders-'));
    dirs.push(dir);
    const path = join(dir, 'locked.db');
    const db = new Database(path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('CREATE TABLE t (x)');
    const other = new Database(path);
    expect(describeLockHolders(path, -1)).toContain('none visible');
    other.exec('BEGIN IMMEDIATE');
    try {
      const line = describeLockHolders(path, -1);
      expect(line).toContain(`${process.pid}[`);
      expect(line).toContain('| io ');
    } finally {
      other.exec('COMMIT');
    }
  });

  it('never throws on a missing database', () => {
    expect(describeLockHolders('/nonexistent/oracle.db')).toContain('write-lock holders:');
  });
});
