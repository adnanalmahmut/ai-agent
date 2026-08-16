import type { AppLocale } from '@repo/i18n-core';
import type { ComponentProps } from 'react';
import { useCallback } from 'react';
import {
  Link as RouterLink,
  useLocation,
  useNavigate,
  useRevalidator,
} from 'react-router';
import { useLocale } from 'use-intl';

import { localizedPath, stripLocalePrefix } from './routing';

/**
 * Locale-aware navigation.
 *
 * Every href in the application is written *without* a locale — `/sign-in`,
 * `/organizations/new` — and gains one here, from whichever locale the reader
 * is currently in. That is the whole reason this module exists: a component
 * that built `/${locale}/sign-in` itself would be one more place to get the
 * prefix wrong, and the one place a future third locale would have to be
 * taught about.
 *
 * The href shape (`string | { pathname, query }`) is carried over from the
 * previous implementation deliberately. It is a better shape than a bare
 * string — a query built from an object cannot forget to encode a value — and
 * keeping it meant the migration touched no call site that was already
 * correct.
 */

/**
 * The current locale, narrowed.
 *
 * `use-intl` types its locale as a plain string, but the locale route rejected
 * anything that was not one of ours before this subtree existed. Narrowing
 * once here is what keeps the assertion out of every hook that builds a
 * localized URL.
 */
export function useAppLocale(): AppLocale {
  return useLocale() as AppLocale;
}

export type AppHref =
  | string
  | {
      pathname: string;
      query?: Record<string, string | undefined>;
    };

/** Flattens an href into a locale-less path, encoding the query properly. */
export function hrefToPath(href: AppHref): string {
  if (typeof href === 'string') return href;

  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(href.query ?? {})) {
    if (value !== undefined) search.set(key, value);
  }

  const query = search.toString();

  return query ? `${href.pathname}?${query}` : href.pathname;
}

type LinkProps = Omit<ComponentProps<typeof RouterLink>, 'to'> & {
  href: AppHref;
  /** Navigates into another language. Defaults to the current one. */
  locale?: AppLocale;
};

/**
 * A link that keeps the reader in their language.
 *
 * Prefer this over React Router's `Link` for anything inside the localized
 * tree, which is everything.
 */
export function Link({ href, locale, ...rest }: LinkProps) {
  const current = useAppLocale();

  return <RouterLink to={localizedPath(locale ?? current, hrefToPath(href))} {...rest} />;
}

export type NavigateOptions = {
  replace?: boolean;
  locale?: AppLocale;
};

/**
 * Programmatic navigation, locale applied.
 *
 * `replace` matters more here than it looks: after signing in, pushing the
 * dashboard onto the history stack would leave the sign-in form one Back press
 * away, appearing to have failed.
 */
export function useAppNavigate() {
  const navigate = useNavigate();
  const current = useAppLocale();

  return useCallback(
    (href: AppHref, options: NavigateOptions = {}) => {
      const path = localizedPath(options.locale ?? current, hrefToPath(href));

      void navigate(path, { replace: options.replace });
    },
    [current, navigate],
  );
}

/**
 * Re-runs the loaders of every route currently on screen.
 *
 * The replacement for `router.refresh()`, and needed for the same reason: a
 * mutation that changed something a loader read — a new membership, a switched
 * organization, a signed-out session — leaves that data stale, and there is no
 * client state to update that would fix it.
 */
export function useRevalidate(): () => void {
  const { revalidate } = useRevalidator();

  return useCallback(() => {
    void revalidate();
  }, [revalidate]);
}

/**
 * The current location with the locale removed.
 *
 * The base path is already gone — React Router's `basename` strips it before
 * `useLocation` sees anything — so this is the application path, the same
 * vocabulary the route constants are written in.
 */
export function useAppLocation() {
  const location = useLocation();

  return {
    pathname: stripLocalePrefix(location.pathname),
    search: location.search,
    hash: location.hash,
  };
}
