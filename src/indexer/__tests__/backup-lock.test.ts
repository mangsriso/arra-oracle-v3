/**
 * Tests for backup file-lock to prevent race conditions
 * when concurrent reindex processes run close together.
 *
 * @see https://github.com/Soul-Brews-Studio/arra-oracle-v3/issues/1037
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { acquireLock, releaseLock } from '../backup.ts';
import type { LockRuntime } from '../backup-lock.ts';

describe('backup file lock', () => {
  let tmpDir: string;
  let lockPath: string;
  let ownerPath: string;
  let runtime: LockRuntime;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-backup-test-'));
    lockPath = path.join(tmpDir, 'test.db.backup.lock');
    ownerPath = path.join(lockPath, 'owner.json');
    runtime = {
      pid: 4242,
      now: () => 1_000_000,
      isProcessAlive: pid => pid === 4242,
      createToken: () => 'owner-token',
    };
  });

  afterEach(() => {
    releaseLock(lockPath);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  it('acquires lock when no lock exists', () => {
    expect(acquireLock(lockPath, runtime)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);
    releaseLock(lockPath);
  });

  it('fails to acquire when lock already held', () => {
    expect(acquireLock(lockPath, runtime)).toBe(true);
    expect(acquireLock(lockPath, runtime)).toBe(false);
    releaseLock(lockPath);
  });

  it('allows re-acquire after release', () => {
    expect(acquireLock(lockPath, runtime)).toBe(true);
    releaseLock(lockPath);
    expect(acquireLock(lockPath, runtime)).toBe(true);
    releaseLock(lockPath);
  });

  it('writes PID and ownership token to lock file', () => {
    acquireLock(lockPath, runtime);
    const content = JSON.parse(fs.readFileSync(ownerPath, 'utf-8'));
    expect(content).toEqual({
      pid: 4242,
      createdAt: 1_000_000,
      token: 'owner-token',
    });
    releaseLock(lockPath);
  });

  it('does not steal an old lock from a live PID', () => {
    fs.writeFileSync(lockPath, '{"pid":4242,"createdAt":1,"token":"other"}\n');
    const staleTime = runtime.now() - 6 * 60 * 1000;
    fs.utimesSync(lockPath, new Date(staleTime), new Date(staleTime));

    expect(acquireLock(lockPath, runtime)).toBe(false);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token).toBe('other');
  });

  it('reclaims a fresh lock from a dead PID', () => {
    fs.writeFileSync(lockPath, '99999\n');

    expect(acquireLock(lockPath, runtime)).toBe(true);
    expect(JSON.parse(fs.readFileSync(ownerPath, 'utf8')).pid).toBe(4242);
    expect(fs.readdirSync(tmpDir).some(name => name.includes('.reclaimed-pid-99999-0-'))).toBe(true);
  });

  it('can reclaim a later legacy lock from the same reused PID', () => {
    fs.writeFileSync(lockPath, '99999\n');
    expect(acquireLock(lockPath, runtime)).toBe(true);
    releaseLock(lockPath);

    fs.writeFileSync(lockPath, '99999\n');
    expect(acquireLock(lockPath, runtime)).toBe(true);
  });

  it('gives a fresh malformed lock time to finish being written', () => {
    fs.writeFileSync(lockPath, '');
    fs.utimesSync(lockPath, new Date(runtime.now()), new Date(runtime.now()));

    expect(acquireLock(lockPath, runtime)).toBe(false);
  });

  it('reclaims a malformed lock only after the stale grace period', () => {
    fs.writeFileSync(lockPath, 'not-a-lock');
    const staleTime = runtime.now() - 6 * 60 * 1000;
    fs.utimesSync(lockPath, new Date(staleTime), new Date(staleTime));

    expect(acquireLock(lockPath, runtime)).toBe(true);
  });

  it('does not release a replacement owned by someone else', () => {
    expect(acquireLock(lockPath, runtime)).toBe(true);
    fs.unlinkSync(ownerPath);
    fs.rmdirSync(lockPath);
    fs.mkdirSync(lockPath);
    fs.writeFileSync(ownerPath, '{"pid":9000,"createdAt":2,"token":"replacement"}\n');

    releaseLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(ownerPath, 'utf8')).token).toBe('replacement');
  });

  it('releaseLock is safe when lock already removed', () => {
    expect(() => releaseLock(lockPath)).not.toThrow();
  });
});
