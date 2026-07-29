import { describe, expect, it } from 'bun:test';
import { resolveVaultHealth } from '../vault-health.ts';

describe('vault health contract', () => {
  it('reports a resolved configured vault after one settings read', () => {
    let reads = 0;
    expect(resolveVaultHealth({
      getRepo: () => {
        reads += 1;
        return 'owner/vault';
      },
      resolveRepo: () => '/tmp/test-vault',
    })).toEqual({
      state: 'ok',
      repo: 'owner/vault',
      path: '/tmp/test-vault',
    });
    expect(reads).toBe(1);
  });

  it('reports an unconfigured vault without resolving it', () => {
    let resolves = 0;
    expect(resolveVaultHealth({
      getRepo: () => null,
      resolveRepo: () => {
        resolves += 1;
        return '/tmp/unreachable';
      },
    })).toEqual({ state: 'not-configured', repo: null });
    expect(resolves).toBe(0);
  });

  it('gives the watchdog a stable settings failure reason', () => {
    expect(resolveVaultHealth({
      getRepo: () => {
        throw new Error('database unavailable');
      },
      resolveRepo: () => '/tmp/unreachable',
    })).toEqual({
      state: 'degraded',
      repo: null,
      reason: 'settings-unreadable',
      hint: 'settings table unreadable',
    });
  });

  it('gives the watchdog a stable vault resolution failure reason', () => {
    let reads = 0;
    expect(resolveVaultHealth({
      getRepo: () => {
        reads += 1;
        return 'owner/vault';
      },
      resolveRepo: () => {
        throw new Error('not found');
      },
    })).toEqual({
      state: 'degraded',
      repo: 'owner/vault',
      reason: 'vault-resolution-failed',
      hint: 'Vault repo "owner/vault" not found locally. Run: ghq get owner/vault',
    });
    expect(reads).toBe(1);
  });
});
