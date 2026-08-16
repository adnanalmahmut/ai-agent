/**
 * Web-specific i18n configuration.
 *
 * The *identity* of the locales (which exist, which is default, direction)
 * lives in `@repo/i18n-core` and is shared with the backend. This file owns
 * only decisions that are meaningful for the Next.js application: how the
 * locale appears in the URL, and how it is persisted.
 */

/**
 * The two URL shapes the application supports.
 *
 * - `always`:    /ar, /ar/dashboard, /en, /en/dashboard
 * - `as-needed`: /,   /dashboard,    /en, /en/dashboard   (default locale unprefixed)
 *
 * This is the single switch for that decision. Never re-derive URL shape
 * inside a page, component, or link — read it from `routing` instead.
 */
export type LocalePrefixMode = 'always' | 'as-needed';

export const webI18nConfig = {
  localePrefixMode: 'as-needed' as LocalePrefixMode,

  /**
   * Project policy: the URL is the only source of truth for the web locale.
   *
   * With this disabled, next-intl ignores both the `accept-language` header
   * and the locale cookie when resolving a route. `/` therefore always means
   * the default locale, regardless of what the browser or a previous visit
   * would prefer.
   *
   * This must not be lifted into an environment variable, and must not vary
   * per environment — routing has to be reproducible.
   */
  localeDetection: false,

  /**
   * Persisted *preference*, not a routing input.
   *
   * next-intl writes this cookie when the user switches language. The backend
   * may read it as one candidate in its own resolution chain, but it can never
   * override the locale encoded in a web URL.
   */
  localeCookie: {
    name: 'APP_LOCALE',
    path: '/',
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 365,
  },

  /**
   * next-intl emits `Link: <...>; rel="alternate"; hreflang="..."` response
   * headers by default. SEO is explicitly out of scope for this task, so the
   * i18n setup deliberately introduces no SEO surface. Revisit when localized
   * metadata is designed as its own piece of work.
   */
  alternateLinks: false,
} as const;
