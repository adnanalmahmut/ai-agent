import { isAppLocale, type AppLocale } from '@repo/i18n-core';
import { redirect, type LoaderFunctionArgs } from 'react-router';

import { localeFallbackPath, localizedPath } from '@/i18n/routing';

import { AUTH_ROUTES, PLATFORM_ROUTES, RETURN_TO_PARAM } from './routes';
import { returnPathFromUrl } from './safe-return-url';
import { fetchSession } from './session';
import type { PlatformSession } from './session-types';

/**
 * The authentication boundary, expressed as route loaders.
 *
 * A loader runs *before* its route's element is created, and a `redirect`
 * thrown from one aborts the navigation entirely — so there is no frame in
 * which private markup exists and the check then fails. That is the property
 * a `useEffect` guard cannot have: by the time an effect runs, the component
 * has already rendered and, on a dashboard, already asked for data.
 *
 * The browser is still not the security boundary. Every request the private
 * tree makes is authorized again by the backend against the database. What
 * this buys is that an unauthenticated visitor is *navigated* correctly
 * instead of being shown an empty shell full of failed requests.
 */

/** Stable id so children can read the session without re-fetching it. */
export const PROTECTED_ROUTE_ID = 'protected';

/** Stable id for the locale route, whose loader holds the messages. */
export const LOCALE_ROUTE_ID = 'locale';

/**
 * Validates the `:locale` segment before anything below it renders.
 *
 * Returning the locale rather than letting each consumer re-read `params`
 * means the value has been narrowed from `string | undefined` to `AppLocale`
 * exactly once, at the edge.
 */
export function requireLocale(params: { locale?: string }, pathname: string): AppLocale {
  if (isAppLocale(params.locale)) return params.locale;

  throw redirect(localeFallbackPath(pathname));
}

/**
 * Guards the private tree.
 *
 * Capturing `returnTo` here is the whole reason the redirect is built in a
 * loader rather than declared as a static route: the loader is the first
 * place that knows *which* private URL was asked for, and that is the value
 * worth carrying through a sign-in.
 */
export async function protectedLoader({
  request,
  params,
}: LoaderFunctionArgs): Promise<PlatformSession> {
  const url = new URL(request.url);
  const locale = requireLocale(params, url.pathname);

  const session = await fetchSession();
  if (session) return session;

  const returnTo = returnPathFromUrl(url);

  // `/` is where an unremembered sign-in lands anyway, so carrying it would
  // only add noise to the URL.
  const query =
    returnTo === PLATFORM_ROUTES.dashboard
      ? ''
      : `?${RETURN_TO_PARAM}=${encodeURIComponent(returnTo)}`;

  throw redirect(`${localizedPath(locale, AUTH_ROUTES.signIn)}${query}`);
}

/**
 * Keeps an authenticated user off the two pages whose only purpose is to
 * authenticate them.
 *
 * Only sign-in and sign-up. Verification and password reset stay reachable
 * with a session on purpose — a signed-in user may still need to confirm their
 * address, or may have followed a reset link from their mailbox.
 */
export async function guestLoader({
  request,
  params,
}: LoaderFunctionArgs): Promise<null> {
  const url = new URL(request.url);
  const locale = requireLocale(params, url.pathname);

  const session = await fetchSession();
  if (!session) return null;

  throw redirect(localizedPath(locale, PLATFORM_ROUTES.dashboard));
}
