import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { createAuthorizationGuard } from '../authorization.ts';
import {
  SESSION_COOKIE_NAME,
  isStrictLoopbackAddress,
  remoteAddress,
  type AuthState,
} from '../security.ts';

function testApp(peerAddress: string | null, authState: AuthState) {
  let mutations = 0;
  const app = new Elysia()
    .use(createAuthorizationGuard({
      getAuthState: () => authState,
      getPeerAddress: () => peerAddress,
      verifySession: (token) => token === 'valid-session',
    }))
    .get('/api/health', () => ({ status: 'ok' }))
    .get('/api/auth/status', () => ({ authEnabled: authState.authEnabled }))
    .post('/api/auth/login', () => ({ success: true }))
    .get('/api/settings', () => ({ protected: true }))
    .post('/api/mutate', () => ({ mutations: ++mutations }))
    .options('/api/mutate', () => new Response(null, { status: 204 }))
    .post('/mcp/tools', () => ({ tools: [] }))
    .post('/mcp/call', () => ({ content: [{ type: 'text', text: 'ok' }] }))
    .post('/mcp/other', () => ({ unexpected: true }))
    .get('/outside', () => ({ public: true }));
  return { app, mutationCount: () => mutations };
}

function request(app: Elysia, path: string, init: RequestInit = {}) {
  return app.handle(new Request(`http://oracle.test${path}`, init));
}

describe('strict peer loopback detection', () => {
  test('accepts IPv4 127/8, IPv6 loopback, and IPv4-mapped loopback', () => {
    for (const address of [
      '127.0.0.1',
      '127.255.255.254',
      '::1',
      '0:0:0:0:0:0:0:1',
      '::ffff:127.0.0.1',
      '0:0:0:0:0:ffff:127.1.2.3',
    ]) {
      expect(isStrictLoopbackAddress(address)).toBe(true);
    }
  });

  test('rejects names, RFC1918, public, malformed, and absent addresses', () => {
    for (const address of [
      'localhost',
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '8.8.8.8',
      '127.invalid',
      null,
    ]) {
      expect(isStrictLoopbackAddress(address)).toBe(false);
    }
  });

  test('requestIP null and exceptions fail closed', () => {
    const req = new Request('http://oracle.test/api/settings');
    expect(remoteAddress({ requestIP: () => null }, req)).toBeNull();
    expect(remoteAddress({ requestIP: () => { throw new Error('closed'); } }, req)).toBeNull();
    expect(remoteAddress(null, req)).toBeNull();
  });
});

describe('global HTTP authorization', () => {
  test('auth-disabled setup is local-only and spoofed forwarding headers do not help', async () => {
    const local = testApp('127.0.0.1', { authEnabled: false, localBypass: true });
    expect((await request(local.app, '/api/settings')).status).toBe(200);

    const remote = testApp('10.20.30.40', { authEnabled: false, localBypass: true });
    const denied = await request(remote.app, '/api/settings', {
      headers: { 'x-forwarded-for': '127.0.0.1' },
    });
    expect(denied.status).toBe(401);

    const unknownPeer = testApp(null, { authEnabled: false, localBypass: true });
    expect((await request(unknownPeer.app, '/api/settings')).status).toBe(401);
  });

  test('keeps health, auth bootstrap, preflight, and non-API routes public', async () => {
    const { app } = testApp('203.0.113.5', { authEnabled: true, localBypass: false });
    expect((await request(app, '/api/health')).status).toBe(200);
    expect((await request(app, '/api/auth/status')).status).toBe(200);
    expect((await request(app, '/api/auth/login', { method: 'POST' })).status).toBe(200);
    expect((await request(app, '/api/mutate', { method: 'OPTIONS' })).status).toBe(204);
    expect((await request(app, '/outside')).status).toBe(200);
  });

  test('protects API reads and mutations before their handlers run', async () => {
    const { app, mutationCount } = testApp(
      '203.0.113.5',
      { authEnabled: true, localBypass: false },
    );
    expect((await request(app, '/api/settings')).status).toBe(401);
    expect((await request(app, '/api/mutate', { method: 'POST' })).status).toBe(401);
    expect(mutationCount()).toBe(0);
  });

  test('allows a valid session remotely and strict local bypass when configured', async () => {
    const remote = testApp('203.0.113.5', { authEnabled: true, localBypass: false });
    const authenticated = await request(remote.app, '/api/settings', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=valid-session` },
    });
    expect(authenticated.status).toBe(200);

    const local = testApp('127.0.0.2', { authEnabled: true, localBypass: true });
    expect((await request(local.app, '/api/settings')).status).toBe(200);

    const noBypass = testApp('127.0.0.1', { authEnabled: true, localBypass: false });
    expect((await request(noBypass.app, '/api/settings')).status).toBe(401);
  });

  test('peer resolver exceptions fail closed before protected handlers', async () => {
    const app = new Elysia()
      .use(createAuthorizationGuard({
        getAuthState: () => ({ authEnabled: false, localBypass: true }),
        getPeerAddress: () => { throw new Error('socket closed'); },
      }))
      .get('/api/settings', () => ({ protected: true }));
    expect((await request(app, '/api/settings')).status).toBe(401);
  });

  test('preserves only exact credential-less loopback MCP proxy endpoints', async () => {
    const local = testApp('127.0.0.1', { authEnabled: true, localBypass: false });
    const proxyHeaders = { 'content-type': 'application/json' };
    const tools = await request(local.app, '/mcp/tools', {
      method: 'POST',
      headers: proxyHeaders,
      body: '{}',
    });
    const call = await request(local.app, '/mcp/call', {
      method: 'POST',
      headers: proxyHeaders,
      body: JSON.stringify({ name: '____IMPORTANT', arguments: {} }),
    });
    expect(tools.status).toBe(200);
    expect(call.status).toBe(200);
    expect((await request(local.app, '/mcp/other', { method: 'POST' })).status).toBe(401);

    const remote = testApp('203.0.113.5', { authEnabled: true, localBypass: false });
    expect((await request(remote.app, '/mcp/tools', {
      method: 'POST',
      headers: proxyHeaders,
      body: '{}',
    })).status).toBe(401);
  });

  test('loopback MCP exemption does not depend on readable auth settings', async () => {
    const app = new Elysia()
      .use(createAuthorizationGuard({
        getAuthState: () => { throw new Error('settings unavailable'); },
        getPeerAddress: () => '127.0.0.1',
      }))
      .post('/mcp/tools', () => ({ tools: [] }))
      .get('/api/settings', () => ({ protected: true }));
    expect((await request(app, '/mcp/tools', { method: 'POST', body: '{}' })).status).toBe(200);
    expect((await request(app, '/api/settings')).status).toBe(401);
  });
});
