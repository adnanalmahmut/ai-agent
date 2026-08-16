import { useCallback } from 'react';

import { useAppLocale } from '@/i18n/navigation';

import { authClient } from '../auth-client';
import { absoluteAppUrl } from '../callback-urls';
import { AUTH_ROUTES, PLATFORM_ROUTES } from '../routes';
import { safeReturnPath } from '../safe-return-url';
import { useAuthAction } from './use-auth-action';

/** The only provider the backend has configured. */
export const GOOGLE_PROVIDER = 'google';

/**
 * Starts the Google flow.
 *
 * Better Auth owns the protocol end to end — the authorization URL, `state`,
 * PKCE and the token exchange are all its business, and none of it is
 * reconstructed here. This hook decides one thing: where the user comes back
 * to.
 *
 * The callbacks have to be **absolute** URLs on the platform origin. Google
 * redirects the browser to the *backend*, and the backend then redirects to
 * `callbackURL`; a relative path at that point would resolve against the
 * backend's own origin and strand the user on the API. The backend validates
 * these against its `trustedOrigins`, so an attacker cannot substitute their
 * own.
 *
 * The locale prefix is applied through `getPathname` rather than by string
 * concatenation, so a user who started in Arabic comes back to Arabic — via a
 * detour through Google, which knows nothing about either.
 */
export function useGoogleSignIn(returnTo?: string | null) {
  const locale = useAppLocale();
  const { isPending, error, reset, run } = useAuthAction();

  const start = useCallback(async () => {
    const destination = safeReturnPath(returnTo, PLATFORM_ROUTES.dashboard);

    await run(() =>
      authClient.signIn.social({
        provider: GOOGLE_PROVIDER,
        callbackURL: absoluteAppUrl(destination, locale, window.location.origin),
        // A provider failure must land somewhere that can explain itself.
        // Better Auth appends its own `error` query parameter here.
        errorCallbackURL: absoluteAppUrl(
          AUTH_ROUTES.signIn,
          locale,
          window.location.origin,
        ),
      }),
    );

    // On success Better Auth's own redirect fetch-plugin has already set
    // `window.location`; there is deliberately nothing to do here.
  }, [locale, returnTo, run]);

  return { start, isPending, error, reset };
}
