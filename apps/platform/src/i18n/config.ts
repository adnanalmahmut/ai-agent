/**
 * Platform-specific i18n policy.
 *
 * The *identity* of the locales — which exist, which is default, which
 * direction each reads in — lives in `@repo/i18n-core` and is shared with the
 * backend. This file owns only what is meaningful for this application: how
 * the locale appears in the URL, and how the choice is persisted for the
 * backend to read.
 */

/**
 * The locale is always in the path.
 *
 * Under Next.js this was a two-mode switch (`always` / `as-needed`, with the
 * default locale unprefixed). React Router matches on a real `:locale`
 * segment, so "sometimes there is no segment" would mean two route trees and
 * a set of ambiguities — `/organizations` would be indistinguishable from a
 * locale named `organizations`. One shape, always present, is both simpler and
 * the shape the deployment plan asks for: `/platform/ar/…`, `/platform/en/…`.
 *
 * A visitor who omits it is redirected rather than guessed at; see
 * `localeFallbackPath`.
 */
export const LOCALE_PREFIX = 'always' as const;

/**
 * Project policy: the URL is the only source of truth for the platform's
 * locale.
 *
 * Neither the `accept-language` header nor the cookie below may change which
 * language a URL renders in. A link shared between two people must show them
 * the same page.
 */
export const LOCALE_DETECTION = false;

/**
 * Persisted *preference*, not a routing input.
 *
 * Written when the user switches language. The backend reads it as one
 * candidate in its own resolution chain — it is how an emailed verification
 * link arrives in the language the reader was last using — but it can never
 * override the locale encoded in a platform URL.
 *
 * `path: '/'` rather than `/platform`, because the reader is the backend at
 * `/api`, not this application.
 */
export const LOCALE_COOKIE = {
  name: 'APP_LOCALE',
  path: '/',
  sameSite: 'Lax',
  maxAgeSeconds: 60 * 60 * 24 * 365,
} as const;
