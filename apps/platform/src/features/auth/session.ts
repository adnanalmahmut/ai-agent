import { ApiUnavailableError } from '@/lib/application-api';

import { authClient } from './auth-client';
import type { PlatformSession } from './session-types';

/**
 * Asks the backend who the current user is.
 *
 * This is the read the whole private tree is gated on, so what it does when
 * things go wrong matters as much as what it returns.
 *
 * A response saying "no session" means exactly that, and the caller redirects.
 * A request that never arrived — the API down, the browser offline, a proxy
 * misconfigured — is **not** the same thing, and reporting it as "signed out"
 * would dump a working user onto a sign-in page that also cannot reach the
 * server. So it throws instead, and the router's error boundary offers a
 * retry.
 *
 * Nothing is cached here. The backend runs no session cache — no
 * `cookieCache`, no Redis — so what comes back is the current database state:
 * a revoked session, a deactivated account or a changed role is visible on the
 * next navigation. Caching it in the browser would undo that on purpose.
 */
export async function fetchSession(): Promise<PlatformSession | null> {
  let result: Awaited<ReturnType<typeof authClient.getSession>>;

  try {
    result = await authClient.getSession({
      fetchOptions: { cache: 'no-store' },
    });
  } catch (thrown) {
    throw new ApiUnavailableError(thrown);
  }

  // Better Auth resolves rather than rejects for anything the server answered.
  // A 401 here is an anonymous visitor, which is a normal outcome; anything
  // else with no data is treated the same way, because the only decision this
  // function makes is "is there a session".
  if (result.error && isTransportFailure(result.error)) {
    throw new ApiUnavailableError(result.error);
  }

  return result.data ?? null;
}

/**
 * A failure with neither a status nor a code never reached the server.
 *
 * The same signature `normalizeAuthError` reads for `NETWORK_ERROR`, applied
 * here to a different decision: whether to redirect or to say the platform is
 * unreachable.
 */
function isTransportFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return true;

  const record = error as Record<string, unknown>;

  return (
    typeof record.status !== 'number' && typeof record.code !== 'string'
  );
}
