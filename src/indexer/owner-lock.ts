import { dlopen, FFIType, ptr } from 'bun:ffi';

export interface IndexerOwnerLock { release: () => void }

const libc = dlopen('libc.so.6', {
  open: { args: [FFIType.ptr, FFIType.i32, FFIType.u32], returns: FFIType.i32 },
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
});

const O_RDWR = 2;
const O_CREAT = 64;
const O_NOFOLLOW = 131_072;
const LOCK_EX = 2;
const LOCK_NB = 4;

export function acquireIndexerOwnerLock(path: string): IndexerOwnerLock {
  const encoded = new TextEncoder().encode(`${path}\0`);
  const fd = libc.symbols.open(ptr(encoded), O_RDWR | O_CREAT | O_NOFOLLOW, 0o600);
  if (fd < 0) throw new Error(`Cannot open indexer owner lock: ${path}`);
  if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    libc.symbols.close(fd);
    throw new Error('Another asynchronous indexer owner is active');
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      libc.symbols.close(fd);
    },
  };
}
