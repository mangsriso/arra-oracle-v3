import { Elysia } from 'elysia';
import {
  authorizeRequest,
  remoteAddress,
  sessionCookieFromRequest,
  verifySessionToken,
  type AuthState,
} from './security.ts';

interface PeerServer {
  requestIP?: (request: Request) => { address?: unknown } | null;
}

export interface AuthorizationGuardOptions {
  getAuthState: () => AuthState;
  getPeerAddress?: (server: PeerServer | null, request: Request) => string | null;
  verifySession?: (token: string) => boolean;
}

export function createAuthorizationGuard(options: AuthorizationGuardOptions) {
  const getPeerAddress = options.getPeerAddress ?? remoteAddress;
  const verifySession = options.verifySession ?? verifySessionToken;

  return new Elysia({ name: 'oracle-http-authorization' }).onRequest(({ server, request }) => {
    let peerAddress: string | null = null;
    try {
      peerAddress = getPeerAddress(server, request);
    } catch {
      // Socket peer resolution is security-sensitive: failure must not become local.
    }

    const result = authorizeRequest({
      method: request.method,
      pathname: new URL(request.url).pathname,
      peerAddress,
      sessionValue: sessionCookieFromRequest(request),
      getAuthState: options.getAuthState,
      verifySession,
    });
    if (result.allowed) return;

    return new Response(
      JSON.stringify({ error: 'Unauthorized', requiresAuth: true }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    );
  });
}
