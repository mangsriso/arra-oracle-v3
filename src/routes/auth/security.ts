import { createHmac, timingSafeEqual } from 'crypto';

const SESSION_SECRET = process.env.ORACLE_SESSION_SECRET || crypto.randomUUID();

export const SESSION_COOKIE_NAME = 'oracle_session';
export const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

export interface AuthState {
  authEnabled: boolean;
  localBypass: boolean;
}

export interface AuthorizationInput {
  method: string;
  pathname: string;
  peerAddress: string | null;
  sessionValue?: string;
  getAuthState: () => AuthState;
  verifySession?: (token: string) => boolean;
}

export interface AuthorizationResult {
  allowed: boolean;
  reason:
    | 'outside-protected-surface'
    | 'preflight'
    | 'public'
    | 'loopback-mcp'
    | 'auth-disabled-loopback'
    | 'local-bypass'
    | 'session'
    | 'unauthorized';
}

interface RequestIpServer {
  requestIP?: (request: Request) => { address?: unknown } | null;
}

function isIpv4Loopback(address: string): boolean {
  const octets = address.split('.');
  if (octets.length !== 4) return false;
  if (!octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    return false;
  }
  return Number(octets[0]) === 127;
}

export function isStrictLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const normalized = address.trim().toLowerCase().split('%', 1)[0];
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  if (isIpv4Loopback(normalized)) return true;

  const mappedPrefixes = ['::ffff:', '0:0:0:0:0:ffff:'];
  for (const prefix of mappedPrefixes) {
    if (normalized.startsWith(prefix)) {
      return isIpv4Loopback(normalized.slice(prefix.length));
    }
  }
  return false;
}

export function remoteAddress(server: RequestIpServer | null, request: Request): string | null {
  try {
    const info = server?.requestIP?.(request);
    return typeof info?.address === 'string' ? info.address : null;
  } catch {
    return null;
  }
}

export function isLocalNetwork(server: RequestIpServer | null, request: Request): boolean {
  return isStrictLoopbackAddress(remoteAddress(server, request));
}

export function generateSessionToken(): string {
  const expires = Date.now() + SESSION_DURATION_MS;
  const signature = createHmac('sha256', SESSION_SECRET)
    .update(String(expires))
    .digest('hex');
  return `${expires}:${signature}`;
}

export function verifySessionToken(token: string): boolean {
  if (!token) return false;
  const colonIdx = token.indexOf(':');
  if (colonIdx === -1) return false;

  const expiresStr = token.substring(0, colonIdx);
  const signature = token.substring(colonIdx + 1);
  const expires = parseInt(expiresStr, 10);
  if (isNaN(expires) || expires < Date.now()) return false;

  const expectedSignature = createHmac('sha256', SESSION_SECRET)
    .update(expiresStr)
    .digest('hex');
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
}

export function sessionCookieFromRequest(request: Request): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

function isProtectedSurface(pathname: string): boolean {
  return pathname === '/api'
    || pathname.startsWith('/api/')
    || pathname === '/mcp'
    || pathname.startsWith('/mcp/');
}

function isPublicRequest(method: string, pathname: string): boolean {
  if ((method === 'GET' || method === 'HEAD') && pathname === '/api/health') return true;
  if ((method === 'GET' || method === 'HEAD') && pathname === '/api/auth/status') return true;
  return method === 'POST' && pathname === '/api/auth/login';
}

function isLoopbackMcpRequest(method: string, pathname: string): boolean {
  return method === 'POST' && (pathname === '/mcp/tools' || pathname === '/mcp/call');
}

export function authorizeRequest(input: AuthorizationInput): AuthorizationResult {
  const method = input.method.toUpperCase();
  if (!isProtectedSurface(input.pathname)) {
    return { allowed: true, reason: 'outside-protected-surface' };
  }
  if (method === 'OPTIONS') return { allowed: true, reason: 'preflight' };
  if (isPublicRequest(method, input.pathname)) return { allowed: true, reason: 'public' };

  const isLoopback = isStrictLoopbackAddress(input.peerAddress);
  if (isLoopback && isLoopbackMcpRequest(method, input.pathname)) {
    return { allowed: true, reason: 'loopback-mcp' };
  }

  let authState: AuthState;
  try {
    authState = input.getAuthState();
  } catch {
    return { allowed: false, reason: 'unauthorized' };
  }

  if (!authState.authEnabled) {
    return isLoopback
      ? { allowed: true, reason: 'auth-disabled-loopback' }
      : { allowed: false, reason: 'unauthorized' };
  }
  if (authState.localBypass && isLoopback) {
    return { allowed: true, reason: 'local-bypass' };
  }

  try {
    const verify = input.verifySession ?? verifySessionToken;
    if (input.sessionValue && verify(input.sessionValue)) {
      return { allowed: true, reason: 'session' };
    }
  } catch {
    // Verification failures are authorization failures.
  }
  return { allowed: false, reason: 'unauthorized' };
}

export function isSessionAuthorized(
  authState: AuthState,
  peerAddress: string | null,
  sessionValue: string | undefined,
): boolean {
  const isLoopback = isStrictLoopbackAddress(peerAddress);
  if (!authState.authEnabled) return isLoopback;
  if (authState.localBypass && isLoopback) return true;
  return verifySessionToken(sessionValue || '');
}
