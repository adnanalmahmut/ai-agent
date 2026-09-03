'use client';

import type { AppLocale } from '@repo/i18n-core';
import type { ComponentProps } from 'react';
import { useCallback } from 'react';
import { useLocale } from 'next-intl';
import { createNavigation } from 'next-intl/navigation';
import { useSearchParams } from 'next/navigation';

import { routing, stripLocalePrefix } from './routing';

const navigation = createNavigation(routing);

export function useAppLocale(): AppLocale {
  return useLocale() as AppLocale;
}

export type AppHref =
  | string
  | {
      pathname: string;
      query?: Record<string, string | undefined>;
    };

export function hrefToPath(href: AppHref): string {
  if (typeof href === 'string') return href;

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(href.query ?? {})) {
    if (value !== undefined) search.set(key, value);
  }

  const query = search.toString();
  return query ? `${href.pathname}?${query}` : href.pathname;
}

type LinkProps = Omit<ComponentProps<typeof navigation.Link>, 'href'> & {
  href: AppHref;
  locale?: AppLocale;
};

export function Link({ href, ...props }: LinkProps) {
  return <navigation.Link href={hrefToPath(href)} {...props} />;
}

export type NavigateOptions = {
  replace?: boolean;
  locale?: AppLocale;
};

export function useAppNavigate() {
  const router = navigation.useRouter();

  return useCallback(
    (href: AppHref, options: NavigateOptions = {}) => {
      const path = hrefToPath(href);
      const navigationOptions =
        options.locale === undefined ? undefined : { locale: options.locale };

      if (options.replace) {
        router.replace(path, navigationOptions);
      } else {
        router.push(path, navigationOptions);
      }
    },
    [router],
  );
}

export function useRevalidate(): () => void {
  const router = navigation.useRouter();
  return useCallback(() => router.refresh(), [router]);
}

export function useAppSearchParams(): URLSearchParams {
  return useSearchParams();
}

export function useAppLocation() {
  const pathname = navigation.usePathname();

  if (typeof window === 'undefined') {
    return { pathname: stripLocalePrefix(pathname), search: '', hash: '' };
  }

  return {
    pathname: stripLocalePrefix(pathname),
    search: window.location.search,
    hash: window.location.hash,
  };
}

export const { getPathname } = navigation;
