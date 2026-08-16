import { stripBasePath, stripLocalePrefix } from '@/i18n/routing';

import {
  AUTHENTICATION_ONLY_PATHS,
  PLATFORM_ROUTES,
  matchesPath,
} from './routes';

/**
 * The one place an untrusted redirect destination is judged.
 *
 * A `returnTo` value arrives from a query string, which means it arrives from
 * whoever wrote the link. Left unchecked it is an open redirect: a phishing
 * mail sends `/sign-in?returnTo=https://evil.example`, the victim signs in on
 * the real site, and the real site hands them straight to the attacker with
 * the authentication already done.
 *
 * The rule is a whitelist, not a blacklist: the value must be a path inside
 * this application, and everything else falls back to the dashboard. That is
 * why the checks below are phrased as "must look like this" rather than "must
 * not look like that" — a new attacker-controlled shape cannot slip through a
 * list it was never on.
 */

/** Long enough for any real deep link; short enough not to be a payload. */
const MAX_LENGTH = 2048;

/**
 * Control characters and backslashes.
 *
 * Browsers strip tab, newline and carriage return from a URL before resolving
 * it, so a value containing one can turn `/<TAB>/evil.example` into
 * `//evil.example` — which passes a naive "starts with one slash" check and
 * then navigates off-site. Backslash is rejected because the URL parser
 * treats it as a slash for http(s). Ordinary spaces are deliberately allowed:
 * they are legal inside a query value, and `URLSearchParams` hands them over
 * already decoded.
 */
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

/**
 * Normalises an untrusted destination to a safe internal path.
 *
 * Returns the fallback rather than `null` for anything rejected: the caller is
 * always about to navigate somewhere, and making every call site invent its
 * own fallback is how one of them ends up forgetting.
 */
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

/**
 * Re-parses the value against a sentinel origin and rejects anything that
 * escaped it.
 *
 * The character checks above already cover the shapes this catches, but they
 * do so by pattern while this does it by definition: if the platform's own
 * origin is not what the value resolves to, it is not an internal path,
 * whatever it looked like.
 */
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

/**
 * Builds the value stored in `returnTo` from a real browser URL.
 *
 * Two sources feed this and they differ. A router location has already had the
 * mount point removed by `basename`; `window.location` has not. Both are
 * normalised here rather than at each call site, because the failure is silent
 * either way — a stored `/platform/reports` sends the reader to
 * `/platform/en/platform/reports`, and a stored `/en/reports` doubles the
 * locale when the sign-in page re-applies one.
 *
 * The query string survives, because a deep link into a filtered list is
 * worthless without it. The fragment does not, and cannot: `useLocation`
 * carries it, but the value stored here has to survive a round trip through a
 * redirect, and nothing guarantees a fragment does.
 */
export function returnPathFromUrl(url: {
  pathname: string;
  search: string;
}): string {
  const path = stripLocalePrefix(stripBasePath(url.pathname));

  return safeReturnPath(`${path}${url.search}`);
}
