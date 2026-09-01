import { afterEach, describe, expect, it } from 'bun:test';
import { publishNoReplace } from '../publication.ts';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) Bun.spawnSync(['rm', '-r', '--', roots.pop()!]);
});

function root(): string {
  const made = Bun.spawnSync(['mktemp', '-d', '/dev/shm/arra-publication.XXXXXX']);
  const value = new TextDecoder().decode(made.stdout).trim();
  roots.push(value);
  return value;
}

describe('no-replace publication safety', () => {
  it('rejects a symlinked canonical directory before writing outside it', async () => {
    const base = root();
    const outside = root();
    Bun.spawnSync(['ln', '-s', '--', outside, `${base}/learnings`]);
    await expect(publishNoReplace(
      `${base}/learnings/escape.md`, 'secret', 'owner', 'a'.repeat(64),
    )).rejects.toThrow('symlink');
    expect(await Bun.file(`${outside}/escape.md`).exists()).toBe(false);
  });

  it('rejects a symlink at the final canonical path', async () => {
    const base = root();
    const outside = root();
    Bun.spawnSync(['mkdir', '-p', '--', `${base}/learnings`]);
    await Bun.write(`${outside}/target.md`, 'outside');
    Bun.spawnSync(['ln', '-s', '--', `${outside}/target.md`, `${base}/learnings/final.md`]);
    await expect(publishNoReplace(
      `${base}/learnings/final.md`, 'replacement', 'owner', 'c'.repeat(64),
    )).rejects.toThrow('symlink');
    expect(await Bun.file(`${outside}/target.md`).text()).toBe('outside');
  });

  it('retries parent durability and temp cleanup faults after publication', async () => {
    const base = root();
    const final = `${base}/nested/learnings/test.md`;
    expect(await publishNoReplace(final, 'bytes', 'owner', 'b'.repeat(64), {
      beforeDirectorySync: () => { throw new Error('injected parent fsync failure'); },
      beforeTempCleanup: () => { throw new Error('injected temp cleanup failure'); },
    })).toBe('published');
    expect(await Bun.file(final).text()).toBe('bytes');
    const entries = Array.from(new Bun.Glob('*').scanSync({ cwd: `${base}/nested/learnings` }));
    expect(entries).toEqual(['test.md']);
    expect(await publishNoReplace(final, 'bytes', 'retry', 'b'.repeat(64))).toBe('adopted');
  });

  it('syncs the containing/new parent chain but never the filesystem root', async () => {
    const base = root();
    const synced: string[] = [];
    await publishNoReplace(
      `${base}/new-a/new-b/learnings/test.md`, 'bytes', 'owner', 'd'.repeat(64),
      { onSyncPath: (path) => synced.push(path), syncOperation: async () => {} },
    );
    expect(synced).not.toContain('/');
    const directories = synced.filter((path) => !path.endsWith('.tmp'));
    expect(directories.slice(0, 4)).toEqual([
      `${base}/new-a/new-b/learnings`, `${base}/new-a/new-b`, `${base}/new-a`, base,
    ]);
  });
});
