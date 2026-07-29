/**
 * Auth routes — /api/auth/{status,login,logout}
 *
 * Shared session helpers live here so the settings/ and feed/ groups
 * can import them for their auth guards without an extra file.
 */

import { Elysia } from 'elysia';
import { getSetting } from '../../db/index.ts';
import { statusRoute } from './status.ts';
import { loginRoute } from './login.ts';
import { logoutRoute } from './logout.ts';
import {
  isSessionAuthorized,
  remoteAddress,
  type AuthState,
} from './security.ts';

export * from './security.ts';

export function isAuthenticated(
  server: any,
  request: Request,
  sessionValue: string | undefined,
): boolean {
  const authState: AuthState = {
    authEnabled: getSetting('auth_enabled') === 'true',
    localBypass: getSetting('auth_local_bypass') !== 'false',
  };
  return isSessionAuthorized(authState, remoteAddress(server, request), sessionValue);
}

export const authRoutes = new Elysia({ prefix: '/api/auth' })
  .use(statusRoute)
  .use(loginRoute)
  .use(logoutRoute);

export * from './model.ts';
