import { stripBasePath, stripLocalePrefix } from '@/i18n/routing';

import {
  AUTHENTICATION_ONLY_PATHS,
  PLATFORM_ROUTES,
  matchesPath,
} from './routes';

const MAX_LENGTH = 2048;

const CONTROL_CHARACTER_CEILING = 0x20;
const DELETE_CHARACTER = 0x7f;
const BACKSLASH = 0x5c;

function hasForbiddenCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (
      code < CONTROL_CHARACTER_CEILING ||
      code === DELETE_CHARACTER ||
      code === BACKSLASH
    ) {
      return true;
    }
  }

  return false;
}

export function safeReturnPath(
  raw: string | null | undefined,
  fallback: string = PLATFORM_ROUTES.dashboard,
): string {
  if (typeof raw !== 'string') return fallback;

  const value = raw.trim();

  if (value.length === 0 || value.length > MAX_LENGTH) return fallback;

  // Must be a path. This one check is what rejects `https://evil.example`,
  // `javascript:alert(1)`, `data:...` and every other absolute form, because
  // not one of them starts with a slash.
  if (!value.startsWith('/')) return fallback;

  // `//evil.example` is a protocol-relative URL: it looks like a path and is
  // not — the browser resolves it against the current scheme.
  if (value.startsWith('//')) return fallback;

  if (hasForbiddenCharacter(value)) return fallback;

  const withoutOrigin = stripOrigin(value);
  if (withoutOrigin === null) return fallback;

  const candidate = stripLocalePrefix(withoutOrigin);

  // Never send a signed-in user back to the page that signs them in.
  if (matchesPath(pathnameOf(candidate), AUTHENTICATION_ONLY_PATHS)) {
    return fallback;
  }

  return candidate;
}

function stripOrigin(value: string): string | null {
  const sentinel = 'https://platform.invalid';

  let url: URL;
  try {
    url = new URL(value, sentinel);
  } catch {
    return null;
  }

  if (url.origin !== sentinel) return null;

  return `${url.pathname}${url.search}${url.hash}`;
}

function pathnameOf(value: string): string {
  const end = value.search(/[?#]/);
  return end === -1 ? value : value.slice(0, end);
}

export function returnPathFromUrl(url: {
  pathname: string;
  search: string;
}): string {
  const path = stripLocalePrefix(stripBasePath(url.pathname));

  return safeReturnPath(`${path}${url.search}`);
}
