import { useCallback } from 'react';

import { useAppNavigate, useRevalidate } from '@/i18n/navigation';

import { authClient } from '../auth-client';
import { AUTH_ROUTES } from '../routes';
import { useAuthAction } from './use-auth-action';

/**
 * Ends the session and clears everything that was derived from it.
 *
 * The cookie is deleted by the *server*, in response to `/sign-out` — nothing
 * here touches `document.cookie`. Deleting it client-side would leave the
 * session row alive in the database, which is the opposite of signing out:
 * the token would keep working for anyone who still had it.
 *
 * Three things then have to be discarded, and each needs its own step. Better
 * Auth's own session atom is reset by the call (its atom listener matches
 * `/sign-out`) and broadcast to other tabs. Navigating with `replace` leaves
 * the private tree without leaving it one Back press away. Revalidating drops
 * the loader data the private routes are still holding — without it, the
 * organization list and the session behind the account menu would survive the
 * sign-out in memory.
 */
export function useSignOut() {
  const navigate = useAppNavigate();
  const revalidate = useRevalidate();
  const { isPending, error, reset, run } = useAuthAction();

  const submit = useCallback(async () => {
    // Navigating regardless would be worse than it looks: the cookie would
    // still be there, the proxy would bounce the user straight back in, and
    // the failure would present as a page that flickered.
    const result = await run(() => authClient.signOut());
    if (!result) return;

    navigate(AUTH_ROUTES.signIn, { replace: true });
    revalidate();
  }, [navigate, revalidate, run]);

  return { submit, isPending, error, reset };
}
