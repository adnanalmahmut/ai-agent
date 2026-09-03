import {
  DEFAULT_LOCALE,
  parseAppLocale,
  type AppLocale,
} from '@repo/i18n-core';

export type OutboundLocaleCandidates = {
  /** A locale explicitly requested by the caller for this specific message. */
  requested?: unknown;
  /** The recipient's saved preference, if the account has one. */
  userPreferred?: unknown;
  /** The locale of the request that triggered this message, read at enqueue time. */
  requestLocale?: unknown;
};

/**
 * Decides the language of an outbound message (email, notification) **before**
 * it is handed to a queue.
 *
 * Order: explicit request → recipient preference → originating request locale
 * → default locale.
 *
 * The result is always a validated `AppLocale`, never an arbitrary string, so
 * a job payload cannot carry `"klingon"` into a worker and blow up — or
 * silently render an untranslated email — hours later.
 *
 * Why resolve here and not in the worker: once a job is picked up there is no
 * request, no headers, and no `I18nContext`. Resolving late would mean
 * guessing, and a retry could then pick a *different* language than the
 * original attempt.
 */
export function resolveOutboundLocale(
  candidates: OutboundLocaleCandidates,
): AppLocale {
  return (
    parseAppLocale(candidates.requested) ??
    parseAppLocale(candidates.userPreferred) ??
    parseAppLocale(candidates.requestLocale) ??
    DEFAULT_LOCALE
  );
}
