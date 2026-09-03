import { parseAppLocale, type AppLocale } from '@repo/i18n-core';

export const APP_LOCALE_HEADER = 'x-app-locale';

export const APP_LOCALE_COOKIE = 'APP_LOCALE';

export type HeaderGetter = (name: string) => string | undefined;

export function nodeHeaderGetter(headers: {
  [key: string]: string | string[] | undefined;
}): HeaderGetter {
  return (name) => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
}

export function webHeaderGetter(
  request: { headers: { get(name: string): string | null } } | undefined,
): HeaderGetter {
  return (name) => request?.headers.get(name) ?? undefined;
}

export function localeFromAppHeader(get: HeaderGetter): AppLocale | undefined {
  return parseAppLocale(get(APP_LOCALE_HEADER));
}

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

function decodeCookieValue(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}
