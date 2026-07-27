/**
 * Vault filesystem helpers — walking, cleanup, path resolution.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { getSetting } from '../db/index.ts';
import { REPO_ROOT } from '../config.ts';

/**
 * Walk all files under dir, skipping symlinks.
 * Returns paths relative to baseDir.
 */
export function walkFiles(
  dir: string,
  baseDir: string,
): Array<{ relativePath: string; fullPath: string }> {
  const results: Array<{ relativePath: string; fullPath: string }> = [];
  if (!fs.existsSync(dir)) return results;

  for (const item of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, item);
    const stat = fs.lstatSync(fullPath); // lstat: don't follow symlinks
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      results.push(...walkFiles(fullPath, baseDir));
    } else {
      results.push({ relativePath: path.relative(baseDir, fullPath), fullPath });
    }
  }
  return results;
}

export function resolveVaultPath(repo: string): string {
  // PATH-independent fast path. Shelling out to `ghq` to locate a path this
  // process already holds makes vault resolution depend on the caller's PATH.
  // 2026-07-26: oracle-server runs from a systemd user unit whose default PATH
  // excludes ~/.local/bin (where ghq lives) — `ghq` exited 127, this threw, and
  // arra_learn silently fell back to writing EVERY learning into the vault's own
  // project scope instead of the caller's (49 misfiled before it was noticed).
  // When REPO_ROOT already is the configured vault, trust it and skip the shell.
  const slug = repo.replace(/\.git$/, '').toLowerCase();
  const root = (REPO_ROOT || '').replace(/\/+$/, '');
  if (root && root.toLowerCase().endsWith(`/${slug}`)) {
    return root; // normalized: a trailing-slash ORACLE_REPO_ROOT must not leak into every derived path
  }
  try {
    const output = execSync(`ghq list -p ${repo}`, { encoding: 'utf-8' }).trim();
    if (!output) throw new Error('empty output');
    return output.split('\n')[0].trim();
  } catch {
    throw new Error(`Vault repo "${repo}" not found via ghq. Run vault:init first.`);
  }
}

export function cleanEmptyDirs(dir: string, stopAt: string): void {
  if (dir === stopAt || !fs.existsSync(dir)) return;
  const items = fs.readdirSync(dir);
  if (items.length === 0) {
    fs.rmdirSync(dir);
    cleanEmptyDirs(path.dirname(dir), stopAt);
  }
}

/**
 * Resolve the vault ψ/ root for shared use by arra_learn, arra_handoff, indexer, etc.
 * Returns the vault repo local path, or a setup hint if not configured.
 */
export function getVaultPsiRoot(): { path: string } | { needsInit: true; hint: string } {
  const repo = getSetting('vault_repo');
  if (!repo) {
    return {
      needsInit: true,
      hint: 'Run: oracle-vault init <owner/repo> to set up central knowledge vault.\nExample: oracle-vault init your-org/oracle-vault',
    };
  }
  try {
    return { path: resolveVaultPath(repo) };
  } catch {
    return {
      needsInit: true,
      hint: `Vault repo "${repo}" not found locally. Run: ghq get ${repo}`,
    };
  }
}
