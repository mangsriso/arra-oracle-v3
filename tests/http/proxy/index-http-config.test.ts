import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_HTTP_BASE_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_REQUEST_TIMEOUT_MS,
  normalizeHttpProxyConfig,
  parseHttpProxyConfig,
} from '../../../src/index-http.ts';

const defaults = {
  baseUrl: DEFAULT_HTTP_BASE_URL,
  timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
};

describe('HTTP MCP proxy configuration', () => {
  test('preserves production defaults and accepts safe overrides', () => {
    expect(parseHttpProxyConfig({})).toEqual(defaults);
    expect(parseHttpProxyConfig({
      ORACLE_HTTP_BASE_URL: 'http://127.0.0.1:54321/',
      ORACLE_HTTP_TIMEOUT_MS: '25',
    })).toEqual({ baseUrl: 'http://127.0.0.1:54321', timeoutMs: 25 });
    expect(parseHttpProxyConfig({
      ORACLE_HTTP_BASE_URL: 'https://oracle.example.test/proxy/',
      ORACLE_HTTP_TIMEOUT_MS: String(MAX_REQUEST_TIMEOUT_MS),
    })).toEqual({
      baseUrl: 'https://oracle.example.test/proxy',
      timeoutMs: MAX_REQUEST_TIMEOUT_MS,
    });
  });

  test('falls back for malformed, insecure, or stateful URLs', () => {
    for (const baseUrl of [
      'not a URL',
      'http://oracle.example.test',
      'https://user:secret@oracle.example.test',
      'https://oracle.example.test/?',
      'https://oracle.example.test/?token=secret',
      'https://oracle.example.test/#',
      'https://oracle.example.test/#fragment',
    ]) {
      expect(parseHttpProxyConfig({ ORACLE_HTTP_BASE_URL: baseUrl })).toEqual(defaults);
    }
  });

  test('falls back for malformed or runtime-unsafe timeouts', () => {
    for (const timeout of [
      'not-a-number', '-1', '0', '1.5', '1e3', '0x10', String(MAX_REQUEST_TIMEOUT_MS + 1),
    ]) {
      expect(parseHttpProxyConfig({ ORACLE_HTTP_TIMEOUT_MS: timeout })).toEqual(defaults);
    }
  });

  test('normalizes explicitly supplied config at the exported client boundary', () => {
    for (const timeoutMs of [Number.NaN, 0, -1, MAX_REQUEST_TIMEOUT_MS + 1]) {
      expect(normalizeHttpProxyConfig({
        baseUrl: 'http://remote.example.test',
        timeoutMs,
      })).toEqual(defaults);
    }
  });
});
