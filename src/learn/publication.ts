export type PublicationResult = 'published' | 'adopted';

export interface PublicationHooks {
  beforeDirectorySync?: () => void;
  beforeTempCleanup?: () => void;
  afterLink?: () => void;
  renewLease?: () => boolean;
  renewIntervalMs?: number;
  onSyncPath?: (path: string) => void;
  syncOperation?: (path: string) => Promise<void>;
}

function directoryOf(file: string): string {
  const slash = file.lastIndexOf('/');
  if (slash === 0) return '/';
  if (slash < 0) throw new Error('Publication path must be absolute');
  return file.slice(0, slash);
}

async function command(args: string[], action: string, capture = false): Promise<string> {
  const child = Bun.spawn(args, {
    stdout: capture ? 'pipe' : 'ignore', stderr: 'pipe',
  });
  const stdout = capture ? new Response(child.stdout).text() : Promise.resolve('');
  const stderr = new Response(child.stderr).text();
  const [code, output] = await Promise.all([child.exited, stdout, stderr]);
  if (code !== 0) throw new Error(`${action} failed (${code})`);
  return output.trim();
}

async function identicalFile(file: string, content: string): Promise<boolean> {
  const existing = Bun.file(file);
  return await existing.exists() && await existing.text() === content;
}

async function assertNoSymlinkEscape(target: string): Promise<void> {
  const lexical = await command(['realpath', '-m', '-s', '--', target], 'resolve lexical path', true);
  const physical = await command(['realpath', '-m', '--', target], 'resolve physical path', true);
  if (lexical !== physical) throw new Error('Publication path contains a symlink');
}

async function missingDirectories(directory: string): Promise<string[]> {
  const missing: string[] = [];
  let current = directory;
  while (current !== '/') {
    const probe = Bun.spawn(['test', '-d', '--', current], { stdout: 'ignore', stderr: 'ignore' });
    if (await probe.exited === 0) break;
    missing.push(current);
    current = directoryOf(current);
  }
  return missing;
}

function heartbeat(hooks: PublicationHooks) {
  let lost: unknown = null;
  const renew = () => {
    if (!hooks.renewLease || lost) return;
    try {
      if (!hooks.renewLease()) lost = new Error('Reservation fence was lost during publication');
    } catch (error) { lost = error; }
  };
  renew();
  const timer = hooks.renewLease
    ? setInterval(renew, Math.max(1, hooks.renewIntervalMs ?? 1_000))
    : null;
  return {
    assert() { if (lost) throw lost; },
    stop() { if (timer) clearInterval(timer); },
  };
}

async function syncPath(target: string, hooks: PublicationHooks): Promise<void> {
  hooks.onSyncPath?.(target);
  if (hooks.syncOperation) await hooks.syncOperation(target);
  else await command(['sync', '-d', '--', target], `fsync ${target}`);
}

async function syncPublicationParents(
  directory: string, created: string[], hooks: PublicationHooks,
): Promise<void> {
  const ordered: string[] = [];
  const add = (path: string) => { if (path !== '/' && !ordered.includes(path)) ordered.push(path); };
  add(directory);
  for (const path of created) add(path);
  if (created.length) add(directoryOf(created.at(-1)!));
  for (const path of ordered) await syncPath(path, hooks);
}

export async function publishNoReplace(
  finalPath: string,
  content: string,
  ownerToken: string,
  fingerprint: string,
  hooks: PublicationHooks = {},
): Promise<PublicationResult> {
  const fence = heartbeat(hooks);
  let temp: string | null = null;
  let created: string[] = [];
  const directory = directoryOf(finalPath);
  try {
    created = await missingDirectories(directory);
    fence.assert();
    await assertNoSymlinkEscape(directory);
    await command(['mkdir', '-p', '-m', '700', '--', directory], 'create learning directory');
    fence.assert();
    await assertNoSymlinkEscape(directory);
    await assertNoSymlinkEscape(finalPath);
    if (await identicalFile(finalPath, content)) {
      await syncPath(finalPath, hooks);
      fence.assert();
      await syncPublicationParents(directory, created, hooks);
      fence.assert();
      return 'adopted';
    }
    if (await Bun.file(finalPath).exists()) throw new Error('Canonical learning path conflict');

    temp = await command([
      'mktemp', '-p', directory, '--suffix=.tmp',
      `.arra-learn.${fingerprint}.${ownerToken}.XXXXXX`,
    ], 'create exclusive publication temp', true);
    fence.assert();
    await Bun.write(temp, content, { mode: 0o600, createPath: false });
    await syncPath(temp, hooks);
    fence.assert();
    const linked = Bun.spawn(['ln', '--', temp, finalPath], { stdout: 'ignore', stderr: 'ignore' });
    if (await linked.exited !== 0) {
      const adopted = await identicalFile(finalPath, content);
      await Bun.file(temp).delete();
      temp = null;
      await syncPublicationParents(directory, created, hooks);
      fence.assert();
      if (adopted) return 'adopted';
      throw new Error('No-replace publication failed');
    }
    hooks.afterLink?.();
    fence.assert();
    try { hooks.beforeDirectorySync?.(); } catch { /* real fsync still follows */ }
    await syncPublicationParents(directory, created, hooks);
    fence.assert();
    try { hooks.beforeTempCleanup?.(); } catch { /* cleanup still follows */ }
    await Bun.file(temp).delete();
    temp = null;
    await syncPath(directory, hooks);
    fence.assert();
    return 'published';
  } catch (cause) {
    try {
      if (temp && await Bun.file(temp).exists()) await Bun.file(temp).delete();
      if (await Bun.file(directory).exists()) await syncPublicationParents(directory, created, hooks);
    } catch (cleanup) {
      throw new Error(
        `${cause instanceof Error ? cause.message : String(cause)}; publication cleanup failed: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`,
      );
    }
    throw cause;
  } finally {
    fence.stop();
  }
}
