import type { ComponentProps, ReactNode } from 'react';
import { useSyncExternalStore } from 'react';
import { useLocale } from 'use-intl';
import { vi } from 'vitest';

/**
 * Stands in for `@/i18n/navigation`, imitating the library-facing surface so
 * a behaviour test observes the same calls the real router would receive.
 */

const ORIGIN = 'http://admin.test';

type Options = { locale?: string };

export const replaceSpy = vi.fn<(href: string, options?: Options) => void>();
export const refreshSpy = vi.fn<() => void>();

let url = new URL('/', ORIGIN);
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function moveTo(href: string) {
  url = new URL(href, ORIGIN);
  window.history.replaceState(null, '', `${url.pathname}${url.search}`);
  for (const listener of listeners) listener();
}

export function stubLocation(at: string): void {
  moveTo(at);
}

export function Link({
  href,
  locale,
  children,
  ...rest
}: Omit<ComponentProps<'a'>, 'href'> & {
  href: string;
  locale?: string;
  children?: ReactNode;
}) {
  const current = useLocale();
  const prefix = locale ?? current;

  return (
    <a href={`/${prefix}${href === '/' ? '' : href}`} {...rest}>
      {children}
    </a>
  );
}

export function usePathname(): string {
  return useSyncExternalStore(
    subscribe,
    () => url.pathname,
    () => url.pathname,
  );
}

const router = {
  replace(...args: Parameters<typeof replaceSpy>) {
    replaceSpy(...args);
    moveTo(args[0]);
  },
  push(...args: Parameters<typeof replaceSpy>) {
    replaceSpy(...args);
    moveTo(args[0]);
  },
  refresh() {
    refreshSpy();
  },
  prefetch() {},
  back() {},
  forward() {},
};

export const useRouter = () => router;

export function resetNavigationStub() {
  replaceSpy.mockReset();
  refreshSpy.mockReset();
  moveTo('/');
}
