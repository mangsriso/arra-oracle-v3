import { readFileSync, statSync } from 'node:fs';

/**
 * Who holds a write lock on the SQLite database right now (Linux only).
 *
 * The indexer survives SQLITE_BUSY, but the connection holding the lock for more than
 * busy_timeout was never identified (2026-10-06 outage). SQLite takes POSIX advisory
 * locks on the db file and, in WAL mode, on the -shm file; /proc/locks lists them
 * with the owning pid and the file's inode.
 */
export interface LockHolder {
  pid: number;
  file: 'db' | 'wal' | 'shm';
  range: string;
  cmd: string;
}

export function parseWriteLocks(
  procLocks: string,
  inodes: Map<string, LockHolder['file']>,
  excludePid: number,
): Array<Omit<LockHolder, 'cmd'>> {
  const out: Array<Omit<LockHolder, 'cmd'>> = [];
  for (const line of procLocks.split('\n')) {
    // "3: POSIX  ADVISORY  WRITE 1021654 fc:00:9979690 0 EOF"
    const f = line.trim().split(/\s+/);
    if (f.length < 8 || f[3] !== 'WRITE') continue;
    const pid = Number(f[4]);
    const file = inodes.get(f[5].split(':').at(-1) ?? '');
    if (!file || !Number.isInteger(pid) || pid === excludePid) continue;
    out.push({ pid, file, range: `${f[6]}-${f[7]}` });
  }
  return out;
}

function commandOf(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim().slice(0, 120) || '?';
  } catch {
    return '?';
  }
}

/** One log-ready line; never throws. */
export function describeLockHolders(dbPath: string, excludePid = process.pid): string {
  try {
    const inodes = new Map<string, LockHolder['file']>();
    for (const [suffix, file] of [['', 'db'], ['-wal', 'wal'], ['-shm', 'shm']] as const) {
      try { inodes.set(String(statSync(dbPath + suffix).ino), file); } catch { /* file absent */ }
    }
    const holders = parseWriteLocks(readFileSync('/proc/locks', 'utf8'), inodes, excludePid)
      .map((h) => `${h.pid}[${h.file} ${h.range}] ${commandOf(h.pid)}`);
    let io = '?';
    try { io = readFileSync('/proc/pressure/io', 'utf8').split('\n')[0] ?? '?'; } catch { /* no PSI */ }
    return `write-lock holders: ${holders.length ? holders.join('; ') : 'none visible'} | io ${io}`;
  } catch (error) {
    return `write-lock holders: unavailable (${error instanceof Error ? error.message : String(error)})`;
  }
}
