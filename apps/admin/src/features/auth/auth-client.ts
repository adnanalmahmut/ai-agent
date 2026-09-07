import { createAuthClient } from 'better-auth/react';

import { AUTH_BASE_PATH } from '@/config/paths';

/**
 * One instance, no plugins.
 *
 * This surface authenticates against the same Better Auth deployment the
 * customer application does — it does not have accounts, passwords or a
 * session format of its own. The only two operations it performs from the
 * browser are signing in and signing out; every authorization decision is
 * taken on the server, from the session, against the shared policy.
 */
export const authClient = createAuthClient({
  baseURL: new URL(
    AUTH_BASE_PATH,
    typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
  ).toString(),
});
