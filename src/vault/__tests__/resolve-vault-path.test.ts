/**
 * Regression tests for resolveVaultPath().
 *
 * Guards three defects found by an independent audit on 2026-07-27:
 *  - `vault_repo` comes from the settings table and was interpolated straight
 *    into execSync(`ghq list -p ${repo}`): resolveVaultPath('missing; printf
 *    SHELL_INJECTION') executed the fragment;
 *  - the REPO_ROOT fast path trusted a bare textual suffix, so any fabricated
 *    path ending in ".../<owner>/<repo>" was returned as the vault;
 *  - the comparison was lowercased, accepting a differently-cased sibling on a
 *    case-sensitive host.
 * It also pins the behaviour the fast path was added for: resolution must work
 * with `ghq` absent from PATH, which is how a systemd user unit runs.
 *
 * REPO_ROOT is a module-level const derived from env at import time, so each
 * case runs in its own subprocess. That is the only honest way to vary it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DISCOVERY = path.resolve(import.meta.dir, '..', 'discovery.ts');

const RUNNER = `
import { resolveVaultPath } from ${JSON.stringify(DISCOVERY)};
try { console.log("OK:" + resolveVaultPath(process.argv[2])); }
catch (e) { console.log("THREW:" + (e instanceof Error ? e.message : String(e))); }
`;

let tmp: string;
let runnerPath: string;
let realVault: string;   // a genuine git repo at .../owner/oracle-vault-test
let decoyNoGit: string;  // same suffix, not a git repo
let decoyCase: string;   // differently-cased sibling, is a git repo
let aliasLink: string;   // symlink pointing at realVault

const SLUG = 'testowner/oracle-vault-test';

function run(repoRoot: string, repoArg: string, withGhqOnPath = false): string {
  const PATH = withGhqOnPath
    ? `${process.env.HOME}/.local/bin:/usr/bin:/bin`
    : '/usr/bin:/bin';
  const proc = Bun.spawnSync({
    cmd: [process.execPath, 'run', runnerPath, repoArg],
    env: { HOME: process.env.HOME ?? '/tmp', PATH, ORACLE_REPO_ROOT: repoRoot },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return new TextDecoder().decode(proc.stdout).trim();
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-vault-path-'));
  runnerPath = path.join(tmp, 'runner.ts');
  fs.writeFileSync(runnerPath, RUNNER);

  realVault = path.join(tmp, 'real', 'testowner', 'oracle-vault-test');
  fs.mkdirSync(path.join(realVault, '.git'), { recursive: true });

  decoyNoGit = path.join(tmp, 'decoy', 'testowner', 'oracle-vault-test');
  fs.mkdirSync(decoyNoGit, { recursive: true });

  decoyCase = path.join(tmp, 'case', 'TestOwner', 'Oracle-Vault-Test');
  fs.mkdirSync(path.join(decoyCase, '.git'), { recursive: true });

  aliasLink = path.join(tmp, 'alias');
  fs.symlinkSync(realVault, aliasLink);
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('resolveVaultPath — slug gating', () => {
  it('refuses a shell fragment instead of executing it', () => {
    const out = run(realVault, 'missing; printf SHELL_INJECTION', true);
    // Assert on structure, not substring: the thrown message quotes the input
    // verbatim, so the marker legitimately appears in it. What must never happen
    // is the fragment being EXECUTED — which shows up as an OK: result (the
    // pre-fix behaviour returned the injected command's own stdout).
    expect(out).toContain('THREW:');
    expect(out).toContain('not a valid owner/repo slug');
    expect(out.startsWith('OK:')).toBe(false);
    expect(out.split('\n')).toHaveLength(1); // no extra line from a spawned shell
  });

  it.each([
    'no-slash',
    'too/many/slashes',
    'owner/repo with space',
    'owner/repo$(id)',
    '../../etc/passwd',
    '',
  ])('refuses malformed slug %j', (bad) => {
    expect(run(realVault, bad, true)).toContain('not a valid owner/repo slug');
  });
});

describe('resolveVaultPath — REPO_ROOT fast path', () => {
  it('resolves without ghq on PATH when REPO_ROOT is the vault', () => {
    expect(run(realVault, SLUG)).toBe(`OK:${realVault}`);
  });

  it('strips a trailing slash rather than leaking it into derived paths', () => {
    expect(run(`${realVault}//`, SLUG)).toBe(`OK:${realVault}`);
  });

  it('rejects a same-suffix path that is not a git repo', () => {
    expect(run(decoyNoGit, SLUG)).toContain('THREW:');
  });

  it('rejects a differently-cased sibling on a case-sensitive host', () => {
    expect(run(decoyCase, SLUG)).toContain('THREW:');
  });

  it('follows a symlink alias to the real vault', () => {
    expect(run(aliasLink, SLUG)).toBe(`OK:${realVault}`);
  });

  it('tolerates a .git suffix on the configured slug', () => {
    expect(run(realVault, `${SLUG}.git`)).toBe(`OK:${realVault}`);
  });

  it('does not match when the slug is merely a suffix of the directory name', () => {
    // '.../oracle-vault-test' must not satisfy the slug 'testowner/vault-test'
    expect(run(realVault, 'testowner/vault-test')).toContain('THREW:');
  });
});
