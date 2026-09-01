/**
 * Regression test for C-03: vault sync dry-run must only preview changes.
 *
 * All filesystem and Git activity is confined to a temporary fixture. Module
 * imports happen after path env vars are set, so no live Oracle state is used.
 */

import { afterAll, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const originalEnv = {
  dataDir: process.env.ORACLE_DATA_DIR,
  dbPath: process.env.ORACLE_DB_PATH,
  repoRoot: process.env.ORACLE_REPO_ROOT,
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-sync-dry-run-'));
const sourceRoot = path.join(tmp, 'sources', 'github.com', 'test-org', 'test-project');
const vaultPath = path.join(tmp, 'vaults', 'test-owner', 'test-vault');
const dataDir = path.join(tmp, 'oracle-data');
const project = 'github.com/test-org/test-project';
const projectLearningDir = path.join(vaultPath, project, 'ψ', 'memory', 'learnings');

process.env.ORACLE_DATA_DIR = dataDir;
process.env.ORACLE_DB_PATH = path.join(dataDir, 'oracle.db');
process.env.ORACLE_REPO_ROOT = vaultPath;

fs.mkdirSync(path.join(sourceRoot, 'ψ', 'memory', 'learnings'), { recursive: true });
fs.mkdirSync(projectLearningDir, { recursive: true });
fs.writeFileSync(
  path.join(sourceRoot, 'ψ', 'memory', 'learnings', 'added.md'),
  `---\nproject: ${project}\n---\n\n# Added\n`,
);
fs.writeFileSync(
  path.join(sourceRoot, 'ψ', 'memory', 'learnings', 'modified.md'),
  `---\nproject: ${project}\n---\n\n# New content\n`,
);
fs.writeFileSync(
  path.join(projectLearningDir, 'modified.md'),
  `---\nproject: ${project}\n---\n\n# Old content\n`,
);
fs.writeFileSync(path.join(projectLearningDir, 'deleted.md'), '# Stale\n');
fs.writeFileSync(path.join(vaultPath, 'unrelated.txt'), 'committed\n');

function git(...args: string[]): string {
  return execFileSync('git', ['-C', vaultPath, ...args], { encoding: 'utf-8' }).trimEnd();
}

git('init', '-q');
git('config', 'user.name', 'Vault Dry Run Test');
git('config', 'user.email', 'vault-test@example.invalid');
git('add', '-A');
git('commit', '-q', '-m', 'test fixture');
fs.writeFileSync(path.join(vaultPath, 'unrelated.txt'), 'unstaged user change\n');

const realDb = await import('../../db/index.ts');
mock.module(path.resolve(import.meta.dir, '../../db/index.ts'), () => ({
  ...realDb,
  getSetting: (key: string) => key === 'vault_repo' ? 'test-owner/test-vault' : null,
  setSetting: () => {},
}));

// resolveVaultPath shells out to `ghq list -p`. Left real, this test asks the
// machine's ghq for a repo that does not exist, so it passes or fails based on
// the environment rather than on syncVault's dry-run behaviour — the only thing
// under test. Everything else in discovery is kept real: walkFiles and
// cleanEmptyDirs do the actual filesystem work the assertions depend on.
const realDiscovery = await import('../discovery.ts');
mock.module(path.resolve(import.meta.dir, '../discovery.ts'), () => ({
  ...realDiscovery,
  resolveVaultPath: () => vaultPath,
}));

const { syncVault } = await import('../handler.ts');

function hash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function snapshotTree(root: string): string[] {
  const entries: string[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (dir === root && name === '.git') continue;
      const fullPath = path.join(dir, name);
      const relativePath = path.relative(root, fullPath);
      const stat = fs.lstatSync(fullPath);
      if (stat.isDirectory()) {
        entries.push(`dir:${relativePath}`);
        walk(fullPath);
      } else {
        entries.push(`file:${relativePath}:${hash(fs.readFileSync(fullPath))}`);
      }
    }
  };
  walk(root);
  return entries;
}

afterAll(() => {
  if (originalEnv.dataDir === undefined) delete process.env.ORACLE_DATA_DIR;
  else process.env.ORACLE_DATA_DIR = originalEnv.dataDir;
  if (originalEnv.dbPath === undefined) delete process.env.ORACLE_DB_PATH;
  else process.env.ORACLE_DB_PATH = originalEnv.dbPath;
  if (originalEnv.repoRoot === undefined) delete process.env.ORACLE_REPO_ROOT;
  else process.env.ORACLE_REPO_ROOT = originalEnv.repoRoot;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('syncVault dry-run', () => {
  it('previews add/modify/delete without changing files, index, or status', () => {
    const treeBefore = snapshotTree(vaultPath);
    const indexBefore = fs.readFileSync(path.join(vaultPath, '.git', 'index'));
    const statusBefore = git('status', '--porcelain=v1');

    const result = syncVault({ dryRun: true, repoRoot: sourceRoot });

    expect(result).toEqual({
      dryRun: true,
      added: 1,
      modified: 1,
      deleted: 1,
      project,
    });
    expect(snapshotTree(vaultPath)).toEqual(treeBefore);
    expect(hash(fs.readFileSync(path.join(vaultPath, '.git', 'index')))).toBe(hash(indexBefore));
    expect(git('status', '--porcelain=v1')).toBe(statusBefore);
  });
});
