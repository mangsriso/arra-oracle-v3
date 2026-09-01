import { afterEach, describe, expect, it } from 'bun:test';
import { acquireIndexerOwnerLock } from '../owner-lock.ts';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) Bun.spawnSync(['rm', '-r', '--', roots.pop()!]);
});

describe('single asynchronous indexer owner', () => {
  it('excludes a second process-level owner until release', () => {
    const made = Bun.spawnSync(['mktemp', '-d', '/tmp/arra-owner.XXXXXX']);
    const root = new TextDecoder().decode(made.stdout).trim();
    roots.push(root);
    const path = `${root}/owner.lock`;
    const first = acquireIndexerOwnerLock(path);
    expect(() => acquireIndexerOwnerLock(path)).toThrow('Another asynchronous indexer owner');
    first.release();
    const replacement = acquireIndexerOwnerLock(path);
    replacement.release();
  });
});
