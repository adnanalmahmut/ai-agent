import type { AppLocale } from '@repo/i18n-core';
import type { ComponentProps, ReactNode } from 'react';
import { useLocale } from 'use-intl';
import { vi } from 'vitest';

export const navigateSpy =
  vi.fn<
    (href: Href, options?: { replace?: boolean; locale?: AppLocale }) => void
  >();

export const revalidateSpy = vi.fn<() => void>();

export const testRouter = {
  state: {
    location: { pathname: '/', search: '', hash: '' },
    historyAction: 'POP',
  },
};

type Href =
  string | { pathname: string; query?: Record<string, string | undefined> };

export function hrefToPath(href: Href): string {
  if (typeof href === 'string') return href;

  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(href.query ?? {})) {
    if (value !== undefined) search.set(key, value);
  }

  const query = search.toString();

  return query ? `${href.pathname}?${query}` : href.pathname;
}

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

export const useAppNavigate =
  () => (href: Href, options?: { replace?: boolean; locale?: AppLocale }) => {
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

export const useAppLocale = (): AppLocale => useLocale() as AppLocale;
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
