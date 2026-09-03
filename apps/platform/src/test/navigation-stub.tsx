import type { AppLocale } from '@repo/i18n-core';
import type { ComponentProps, ReactNode } from 'react';
import { useLocale } from 'use-intl';
import { vi } from 'vitest';

/**
 * A stand-in for `@/i18n/navigation`.
 *
 * The real module resolves through the App Router, which a component test has no
 * reason to mount: what is worth asserting is *where* a component decides to
 * go and *when* it asks for its data to be refetched — not what the router
 * subsequently did with either.
 *
 * The surface mirrors the real one exactly, so a component that starts using a
 * helper this stub does not have fails loudly rather than silently rendering
 * without it.
 */

/** Records every programmatic navigation, with its options. */
export const navigateSpy = vi.fn<
  (href: Href, options?: { replace?: boolean; locale?: AppLocale }) => void
>();

/** Records every request to refresh server-rendered route data. */
export const revalidateSpy = vi.fn<() => void>();

export const testRouter = {
  state: {
    location: { pathname: '/', search: '', hash: '' },
    historyAction: 'POP',
  },
};

type Href = string | { pathname: string; query?: Record<string, string | undefined> };

export function hrefToPath(href: Href): string {
  if (typeof href === 'string') return href;

  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(href.query ?? {})) {
    if (value !== undefined) search.set(key, value);
  }

  const query = search.toString();

  return query ? `${href.pathname}?${query}` : href.pathname;
}

/**
 * A plain anchor whose `href` is the locale-prefixed path the real `Link`
 * would produce, so a test can assert on the destination a reader would follow.
 */
export function Link({
  href,
  locale,
  children,
  ...rest
}: Omit<ComponentProps<'a'>, 'href'> & {
  href: Href;
  locale?: AppLocale;
  children?: ReactNode;
}) {
  const current = useAppLocale();
  const path = hrefToPath(href);
  const prefix = locale ?? current;

  return (
    <a href={`/${prefix}${path === '/' ? '' : path}`} {...rest}>
      {children}
    </a>
  );
}

export const useAppNavigate = () =>
  (href: Href, options?: { replace?: boolean; locale?: AppLocale }) => {
    navigateSpy(href, options);
    const next = new URL(hrefToPath(href), 'http://platform.test');
    testRouter.state.location = {
      pathname: next.pathname,
      search: next.search,
      hash: next.hash,
    };
    testRouter.state.historyAction = options?.replace ? 'REPLACE' : 'PUSH';
  };
export const useRevalidate = () => revalidateSpy;
export const useAppSearchParams = () =>
  new URLSearchParams(testRouter.state.location.search);

/**
 * Reads the *real* locale from the provider the test rendered with.
 *
 * Returning a constant here would make every Arabic test silently assert
 * English behaviour — which is precisely the class of bug the RTL tests exist
 * to catch.
 */
export const useAppLocale = (): AppLocale => useLocale() as AppLocale;
/**
 * Where the reader currently is, settable by a test.
 *
 * A hardcoded `/` matches no navigation target, which makes any assertion about
 * *which* link is current pass whatever the component decided — including
 * "none" and "several". A component that highlights the wrong tab, or two of
 * them, is only observable from a pathname that actually matches one.
 */
let pathname = '/';

export function stubLocation(at: string): void {
  const next = new URL(at, 'http://platform.test');
  pathname = next.pathname;
  testRouter.state.location = {
    pathname: next.pathname,
    search: next.search,
    hash: next.hash,
  };
  testRouter.state.historyAction = 'POP';
}

export const useAppLocation = () => ({
  pathname,
  search: '',
  hash: '',
});

export function resetNavigationStub() {
  navigateSpy.mockReset();
  revalidateSpy.mockReset();
  pathname = '/';
  testRouter.state.location = { pathname: '/', search: '', hash: '' };
  testRouter.state.historyAction = 'POP';
}
