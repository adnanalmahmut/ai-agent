import { parseAppLocale, type AppLocale } from '@repo/i18n-core';

/** Explicit per-request override sent by first-party clients. */
export const APP_LOCALE_HEADER = 'x-app-locale';

/** Preference cookie written by the web app when the user switches language. */
export const APP_LOCALE_COOKIE = 'APP_LOCALE';

/**
 * Reads one header by lower-case name, or `undefined`.
 *
 * The indirection exists because the same precedence rule has to run against
 * two unrelated request objects: Express requests inside the Nest pipeline,
 * and the Web-Fetch `Request` that Better Auth hands to its email callbacks.
 * Expressing the rule once over a getter is what stops those two paths from
 * drifting into two subtly different locale algorithms.
 */
export type HeaderGetter = (name: string) => string | undefined;

/** Adapter for Node/Express-style header bags, which may hold arrays. */
export function nodeHeaderGetter(headers: {
  [key: string]: string | string[] | undefined;
}): HeaderGetter {
  return (name) => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
}

/** Adapter for the Web-Fetch `Headers` on a Better Auth callback request. */
export function webHeaderGetter(
  request: { headers: { get(name: string): string | null } } | undefined,
): HeaderGetter {
  return (name) => request?.headers.get(name) ?? undefined;
}

/** 1. `X-App-Locale` — an explicit override, and the highest-priority source. */
export function localeFromAppHeader(get: HeaderGetter): AppLocale | undefined {
  return parseAppLocale(get(APP_LOCALE_HEADER));
}

/** 3. The `APP_LOCALE` cookie — a persisted web preference. */
export function localeFromCookieHeader(
  get: HeaderGetter,
): AppLocale | undefined {
  // Read from the raw header rather than a parsed `req.cookies`, so this works
  // with or without cookie middleware installed.
  const header = get('cookie');
  if (!header) return undefined;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;

    const name = part.slice(0, separator).trim();
    if (name !== APP_LOCALE_COOKIE) continue;

    return parseAppLocale(decodeCookieValue(part.slice(separator + 1).trim()));
  }

  return undefined;
}

/**
 * 4. `Accept-Language` — the browser's preference.
 *
 * Picks the highest-quality entry that maps to a supported locale, so
 * `en-GB;q=0.9, fr;q=1.0` still yields `en` rather than giving up at the
 * unsupported first choice.
 */
export function localeFromAcceptLanguage(
  get: HeaderGetter,
): AppLocale | undefined {
  const header = get('accept-language');
  if (!header) return undefined;

  const candidates = header
    .split(',')
    .map((entry) => {
      const [tag, ...parameters] = entry.trim().split(';');
      const quality = parameters
        .map((parameter) => parameter.trim())
        .find((parameter) => parameter.startsWith('q='));

      const parsedQuality = quality ? Number.parseFloat(quality.slice(2)) : 1;

      return {
        // `en-US` and `ar-SA` both narrow to their primary subtag.
        tag: (tag ?? '').trim().split('-')[0],
        quality: Number.isFinite(parsedQuality) ? parsedQuality : 0,
      };
    })
    .filter((candidate) => candidate.tag && candidate.quality > 0)
    .sort((a, b) => b.quality - a.quality);

  for (const candidate of candidates) {
    const locale = parseAppLocale(candidate.tag);
    if (locale) return locale;
  }

  return undefined;
}

/**
 * The documented precedence, in one place:
 *
 *   1. `X-App-Locale` header
 *   2. authenticated user's saved preference
 *   3. `APP_LOCALE` cookie
 *   4. `Accept-Language`
 *   5. (nothing) → the caller's default
 *
 * Every candidate is validated before it is accepted. An unsupported value
 * (`X-App-Locale: klingon`) is *ignored* and the chain continues to the next
 * source, rather than becoming the locale or short-circuiting to the default.
 *
 * `userPreferred` is typed `unknown` on purpose: it arrives from a nullable
 * database column, so the validation has to happen here rather than at every
 * call site.
 */
export function resolveLocaleFromHeaders(
  get: HeaderGetter,
  userPreferred?: unknown,
): AppLocale | undefined {
  return (
    localeFromAppHeader(get) ??
    parseAppLocale(userPreferred) ??
    localeFromCookieHeader(get) ??
    localeFromAcceptLanguage(get)
  );
}

/**
 * A malformed percent-escape (`APP_LOCALE=%ZZ`) makes `decodeURIComponent`
 * throw `URIError`. A locale resolver must never fail a request over an
 * unreadable preference cookie — it treats the value as absent and lets the
 * chain continue.
 */
function decodeCookieValue(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}
