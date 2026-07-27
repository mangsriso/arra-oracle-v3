import { Elysia } from 'elysia';
import { PORT, REPO_ROOT } from '../../config.ts';
import { MCP_SERVER_NAME } from '../../const.ts';
import { getVaultPsiRoot } from '../../vault/handler.ts';
import { getSetting } from '../../db/index.ts';
import pkg from '../../../package.json' with { type: 'json' };

/**
 * Vault resolution state, surfaced so a watchdog can see it.
 *
 * Why this exists: between 2026-06 and 2026-07 `arra_learn` silently wrote every
 * learning into the vault's OWN project scope because vault resolution was
 * failing — the server logged the reason 42 times into a tmux pane nobody reads,
 * and nothing else showed a symptom. 49 learnings were misfiled before anyone
 * noticed. A failure that only appears in a log is a silent failure; this makes
 * it pollable.
 *
 * `degraded` is the load-bearing case: a vault IS configured but did not
 * resolve, so writes are landing outside their project scope.
 */
function vaultHealth(): {
  state: 'ok' | 'degraded' | 'not-configured';
  repo: string | null;
  path?: string;
  hint?: string;
} {
  let repo: string | null = null;
  try {
    repo = getSetting('vault_repo');
  } catch {
    // DB unreadable — report unknown rather than failing liveness.
    return { state: 'degraded', repo: null, hint: 'settings table unreadable' };
  }
  if (!repo) return { state: 'not-configured', repo: null };

  const vault = getVaultPsiRoot();
  if ('path' in vault) return { state: 'ok', repo, path: vault.path };
  return { state: 'degraded', repo, hint: vault.hint };
}

export const healthEndpoint = new Elysia().get('/health', () => {
  const vault = vaultHealth();
  return {
    status: 'ok',
    server: MCP_SERVER_NAME,
    version: pkg.version,
    port: PORT,
    oracle: 'connected',
    repoRoot: REPO_ROOT,
    vault,
  };
}, {
  detail: {
    tags: ['health'],
    menu: { group: 'hidden' },
    summary: 'Server liveness check (includes vault resolution state)',
  },
});
