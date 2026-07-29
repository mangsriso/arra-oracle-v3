import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  MCP_TOOL_CAPABILITIES,
  decideToolCall,
  filterToolCatalog,
  getToolCapability,
} from '../write-policy.ts';
import { writeToolTelemetry } from '../telemetry.ts';

const ALL_TOOL_NAMES = [
  '____IMPORTANT',
  'arra_search',
  'arra_read',
  'arra_learn',
  'arra_list',
  'arra_stats',
  'arra_concepts',
  'arra_thread',
  'arra_threads',
  'arra_thread_read',
  'arra_thread_update',
  'arra_trace',
  'arra_trace_list',
  'arra_trace_get',
  'arra_trace_link',
  'arra_trace_unlink',
  'arra_trace_chain',
  'arra_supersede',
  'arra_handoff',
  'arra_inbox',
  'arra_reflect',
  'arra_verify',
  'arra_schedule_add',
  'arra_schedule_list',
] as const;

const UNCONDITIONAL_WRITES = [
  'arra_learn',
  'arra_thread',
  'arra_thread_update',
  'arra_trace',
  'arra_trace_link',
  'arra_trace_unlink',
  'arra_supersede',
  'arra_handoff',
  'arra_schedule_add',
] as const;

describe('canonical MCP write-capability policy', () => {
  test('exhaustively classifies the 24-name MCP catalog', () => {
    expect(Object.keys(MCP_TOOL_CAPABILITIES).sort()).toEqual([...ALL_TOOL_NAMES].sort());
    expect(Object.keys(MCP_TOOL_CAPABILITIES)).toHaveLength(24);
    expect(UNCONDITIONAL_WRITES.every((name) => getToolCapability(name) === 'write')).toBe(true);
    expect(getToolCapability('arra_verify')).toBe('conditional-write');
    expect(getToolCapability('arra_search')).toBe('telemetry-write');
  });

  test('uses one list policy and fails closed for unclassified tools', () => {
    const catalog = [...ALL_TOOL_NAMES, 'future_unclassified'].map((name) => ({ name }));
    const normal = filterToolCatalog(catalog, false).map((tool) => tool.name);
    const readOnly = filterToolCatalog(catalog, true).map((tool) => tool.name);

    expect(normal).toEqual([...ALL_TOOL_NAMES]);
    for (const name of UNCONDITIONAL_WRITES) expect(readOnly).not.toContain(name);
    expect(readOnly).toContain('arra_search');
    expect(readOnly).toContain('arra_verify');
    expect(readOnly).not.toContain('future_unclassified');
  });

  test('rejects every unconditional write call in read-only mode', () => {
    for (const name of UNCONDITIONAL_WRITES) {
      expect(decideToolCall(name, {}, true).allowed).toBe(false);
      expect(decideToolCall(name, {}, false).allowed).toBe(true);
    }
  });

  test('allows read-only verify by default but rejects check=false', () => {
    expect(decideToolCall('arra_verify', undefined, true).allowed).toBe(true);
    expect(decideToolCall('arra_verify', {}, true).allowed).toBe(true);
    expect(decideToolCall('arra_verify', { check: true }, true).allowed).toBe(true);
    expect(decideToolCall('arra_verify', { check: false }, true).allowed).toBe(false);
    expect(decideToolCall('arra_verify', { check: false }, false).allowed).toBe(true);
  });

  test('keeps search readable while suppressing telemetry and rejects unknown calls', () => {
    const readOnlySearch = decideToolCall('arra_search', { query: 'oracle' }, true);
    expect(readOnlySearch.allowed).toBe(true);
    expect(readOnlySearch.telemetryEnabled).toBe(false);

    const normalSearch = decideToolCall('arra_search', { query: 'oracle' }, false);
    expect(normalSearch.allowed).toBe(true);
    expect(normalSearch.telemetryEnabled).toBe(true);
    expect(decideToolCall('future_unclassified', {}, true).allowed).toBe(false);
    expect(decideToolCall('future_unclassified', {}, false).allowed).toBe(false);
  });
});

describe('read-only search telemetry', () => {
  test('does not execute a search-log write when telemetry is disabled', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE search_log (query TEXT NOT NULL)');
    const insert = sqlite.prepare('INSERT INTO search_log (query) VALUES (?)');

    const wrote = writeToolTelemetry(
      { telemetryEnabled: false },
      () => { insert.run('must-not-write'); },
    );
    const count = sqlite.query('SELECT count(*) AS count FROM search_log')
      .get() as { count: number };

    expect(wrote).toBe(false);
    expect(count.count).toBe(0);
    sqlite.close();
  });
});
