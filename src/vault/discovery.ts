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
  // `repo` comes from the settings table and is interpolated into a shell
  // command below, so gate it before it can reach one. Codex audit 2026-07-27:
  // resolveVaultPath('missing; printf SHELL_INJECTION') executed the fragment.
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    throw new Error(`Vault repo "${repo}" is not a valid owner/repo slug.`);
  }

  const slug = repo.replace(/\.git$/, '');
  let root = (REPO_ROOT || '').replace(/\/+$/, ''); // a trailing slash must not leak into derived paths
  // realpath so a symlink alias to the real vault still matches (the previous
  // version failed that case whenever ghq was unavailable).
  try { root = fs.realpathSync(root); } catch { /* keep the literal value */ }
  // A textual suffix is not proof of identity — any fabricated path ending in
  // ".../<owner>/<repo>" satisfied it, and the lowercase compare additionally
  // accepted a differently-cased sibling on this case-sensitive host (both found
  // by the same audit). Require a case-exact suffix AND a real git repo there.
  if (root.endsWith(`/${slug}`) && fs.existsSync(path.join(root, '.git'))) {
    return root;
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
