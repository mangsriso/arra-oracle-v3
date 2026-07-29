import { describe, expect, test } from 'bun:test';
import { DEFAULT_ORACLE_HOST, resolveOracleHost } from '../bind.ts';

describe('Oracle HTTP bind host', () => {
  test('defaults to IPv4 loopback', () => {
    expect(DEFAULT_ORACLE_HOST).toBe('127.0.0.1');
    expect(resolveOracleHost(undefined)).toBe('127.0.0.1');
    expect(resolveOracleHost('')).toBe('127.0.0.1');
    expect(resolveOracleHost('   ')).toBe('127.0.0.1');
  });

  test('honors the explicit environment escape hatch', () => {
    expect(resolveOracleHost('0.0.0.0')).toBe('0.0.0.0');
    expect(resolveOracleHost(' :: ')).toBe('::');
  });
});
