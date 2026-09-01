import { Elysia } from 'elysia';
import { PORT, REPO_ROOT } from '../../config.ts';
import { MCP_SERVER_NAME } from '../../const.ts';
import { resolveVaultPath } from '../../vault/discovery.ts';
import { getSetting } from '../../db/index.ts';
import { resolveVaultHealth } from './vault-health.ts';
import pkg from '../../../package.json' with { type: 'json' };
import { getEmbeddingModels } from '../../vector/factory.ts';
import { resolveAsyncIndexerConfig } from '../../vector/indexer-config.ts';

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
export const healthEndpoint = new Elysia().get('/health', () => {
  const vault = resolveVaultHealth({
    getRepo: () => getSetting('vault_repo'),
    resolveRepo: resolveVaultPath,
  });
  let indexing;
  try {
    const config = resolveAsyncIndexerConfig(getEmbeddingModels());
    indexing = {
      ready: true,
      producer_enabled: config.producerEnabled,
      workers_enabled: config.workersEnabled,
      active_model_key: config.modelKey,
      index_revision: config.indexRevision,
      dimension: config.dimension,
      collection: config.collection,
    };
  } catch (error) {
    indexing = {
      ready: false,
      producer_enabled: process.env.ORACLE_INDEXER_ENQUEUE === '1',
      workers_enabled: process.env.ORACLE_INDEXER_WORKERS_ENABLED === '1',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    status: 'ok',
    server: MCP_SERVER_NAME,
    version: pkg.version,
    port: PORT,
    oracle: 'connected',
    repoRoot: REPO_ROOT,
    vault,
    indexing,
  };
}, {
  detail: {
    tags: ['health'],
    menu: { group: 'hidden' },
    summary: 'Server liveness check (includes vault resolution state)',
  },
});
