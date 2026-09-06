import {
  DEFAULT_LOCALE,
  parseAppLocale,
  type AppLocale,
} from '@repo/i18n-core';

export type OutboundLocaleCandidates = {
  requested?: unknown;
  userPreferred?: unknown;
  requestLocale?: unknown;
};

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
