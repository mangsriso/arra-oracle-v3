export type VaultHealth =
  | { state: 'ok'; repo: string; path: string }
  | { state: 'not-configured'; repo: null }
  | {
      state: 'degraded';
      repo: string | null;
      reason: 'settings-unreadable' | 'vault-resolution-failed';
      hint: string;
    };

export interface VaultHealthDependencies {
  getRepo: () => string | null;
  resolveRepo: (repo: string) => string;
}

/**
 * Resolve the health contract without importing global DB/filesystem state.
 * The route calls getRepo exactly once so settings failures cannot be hidden
 * by a second lookup through getVaultPsiRoot().
 */
export function resolveVaultHealth(deps: VaultHealthDependencies): VaultHealth {
  let repo: string | null;
  try {
    repo = deps.getRepo();
  } catch {
    return {
      state: 'degraded',
      repo: null,
      reason: 'settings-unreadable',
      hint: 'settings table unreadable',
    };
  }

  if (!repo) return { state: 'not-configured', repo: null };

  try {
    return { state: 'ok', repo, path: deps.resolveRepo(repo) };
  } catch {
    return {
      state: 'degraded',
      repo,
      reason: 'vault-resolution-failed',
      hint: `Vault repo "${repo}" not found locally. Run: ghq get ${repo}`,
    };
  }
}
