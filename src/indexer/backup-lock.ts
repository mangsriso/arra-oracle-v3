import fs from 'fs';

const LOCK_STALE_MS = 5 * 60 * 1000;
const OWNER_FILE = 'owner.json';

interface LockRecord {
  pid: number;
  createdAt: number;
  token?: string;
}

export interface LockRuntime {
  pid: number;
  now: () => number;
  isProcessAlive: (pid: number) => boolean;
  createToken: () => string;
}

const ownedLocks = new Map<string, string>();

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

function defaultRuntime(): LockRuntime {
  return {
    pid: process.pid,
    now: Date.now,
    isProcessAlive: processIsAlive,
    createToken: () => crypto.randomUUID(),
  };
}

function parseLock(raw: string): LockRecord | null {
  const trimmed = raw.trim();
  if (/^[1-9]\d*$/.test(trimmed)) {
    return { pid: Number(trimmed), createdAt: 0 };
  }
  try {
    const parsed = JSON.parse(trimmed) as Partial<LockRecord>;
    if (
      Number.isInteger(parsed.pid) &&
      Number(parsed.pid) > 0 &&
      typeof parsed.createdAt === 'number'
    ) {
      return {
        pid: Number(parsed.pid),
        createdAt: parsed.createdAt,
        ...(typeof parsed.token === 'string' && { token: parsed.token }),
      };
    }
  } catch {
    // Malformed locks are handled conservatively by their age.
  }
  return null;
}

type LockDecision =
  | { kind: 'held' }
  | { kind: 'retry' }
  | { kind: 'reclaim'; tombstone: string };

function ownerPath(lockPath: string, isDirectory: boolean): string {
  return isDirectory ? `${lockPath}/${OWNER_FILE}` : lockPath;
}

function tombstonePath(
  lockPath: string,
  record: LockRecord | null,
  inode: number,
): string {
  const identity = record?.token || (
    record ? `pid-${record.pid}-${record.createdAt}` : `malformed-${inode}`
  );
  return `${lockPath}.reclaimed-${identity.replace(/[^a-zA-Z0-9_-]/g, '_')}-${inode}`;
}

function inspectLock(lockPath: string, runtime: LockRuntime): LockDecision {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(lockPath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { kind: 'retry' };
    return { kind: 'held' };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(ownerPath(lockPath, stat.isDirectory()), 'utf8');
  } catch (error: any) {
    if (error?.code !== 'ENOENT') return { kind: 'held' };

    // mkdir() and owner.json creation are separate syscalls. Give a fresh,
    // ownerless directory a grace period, but do not let a crashed writer
    // leave an empty lock directory that blocks every future backup forever.
    if (!stat.isDirectory()) return { kind: 'retry' };
    const ageMs = runtime.now() - stat.mtimeMs;
    if (ageMs <= LOCK_STALE_MS) return { kind: 'held' };
    console.warn(`⚠️ Reclaiming stale backup lock without owner (age: ${Math.round(ageMs / 1000)}s)`);
    return { kind: 'reclaim', tombstone: tombstonePath(lockPath, null, stat.ino) };
  }

  const record = parseLock(raw);
  if (record) {
    try {
      if (runtime.isProcessAlive(record.pid)) return { kind: 'held' };
      console.warn(`⚠️ Reclaiming backup lock from dead PID ${record.pid}`);
      return { kind: 'reclaim', tombstone: tombstonePath(lockPath, record, stat.ino) };
    } catch {
      return { kind: 'held' };
    }
  }

  const ageMs = runtime.now() - stat.mtimeMs;
  if (ageMs <= LOCK_STALE_MS) return { kind: 'held' };
  console.warn(`⚠️ Reclaiming malformed stale backup lock (age: ${Math.round(ageMs / 1000)}s)`);
  return { kind: 'reclaim', tombstone: tombstonePath(lockPath, null, stat.ino) };
}

/**
 * Acquire a token-owned lock. A live PID always wins, regardless of mtime.
 * Dead owners are reclaimed immediately; malformed locks get a grace period.
 */
export function acquireLock(
  lockPath: string,
  overrides: Partial<LockRuntime> = {},
): boolean {
  const runtime = { ...defaultRuntime(), ...overrides };
  const token = runtime.createToken();
  const record = JSON.stringify({
    pid: runtime.pid,
    createdAt: runtime.now(),
    token,
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      try {
        fs.writeFileSync(`${lockPath}/${OWNER_FILE}`, `${record}\n`, {
          flag: 'wx',
          mode: 0o600,
        });
      } catch (error) {
        try { fs.rmdirSync(lockPath); } catch { /* preserve malformed lock */ }
        throw error;
      }
      ownedLocks.set(lockPath, token);
      return true;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      const decision = inspectLock(lockPath, runtime);
      if (decision.kind === 'held') return false;
      if (decision.kind === 'retry') continue;
      try {
        // Deterministic tombstones serialize concurrent reclaimers: after the
        // first rename, later stale observers cannot rename a replacement over
        // the non-empty tombstone directory.
        fs.renameSync(lockPath, decision.tombstone);
      } catch (renameError: any) {
        if (renameError?.code === 'ENOENT') continue;
        return false;
      }
    }
  }
  return false;
}

/** Release only the lock token acquired by this process instance. */
export function releaseLock(lockPath: string): void {
  const token = ownedLocks.get(lockPath);
  if (!token) return;
  try {
    const record = parseLock(fs.readFileSync(`${lockPath}/${OWNER_FILE}`, 'utf8'));
    if (record?.token === token) {
      fs.unlinkSync(`${lockPath}/${OWNER_FILE}`);
      fs.rmdirSync(lockPath);
    }
  } catch {
    // Missing/replaced lock: do not remove another owner's file.
  } finally {
    ownedLocks.delete(lockPath);
  }
}
