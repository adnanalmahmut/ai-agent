import { useCallback } from 'react';

import { useAppLocale } from '@/i18n/use-app-locale';

import { authClient } from '../auth-client';
import { absoluteAppUrl } from '../callback-urls';
import { AUTH_ROUTES, PLATFORM_ROUTES } from '../routes';
import { safeReturnPath } from '../safe-return-url';
import { useAuthAction } from './use-auth-action';

export const GOOGLE_PROVIDER = 'google';

export function useGoogleSignIn(returnTo?: string | null) {
  const locale = useAppLocale();
  const { isPending, error, reset, run } = useAuthAction();

  const start = useCallback(async () => {
    const destination = safeReturnPath(returnTo, PLATFORM_ROUTES.dashboard);

    await run(() =>
      authClient.signIn.social({
        provider: GOOGLE_PROVIDER,
        callbackURL: absoluteAppUrl(
          destination,
          locale,
          window.location.origin,
        ),
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
