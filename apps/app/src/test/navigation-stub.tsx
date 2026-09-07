import type { ComponentProps, ReactNode } from 'react';
import { useSyncExternalStore } from 'react';
import { useLocale } from 'use-intl';
import { vi } from 'vitest';

/**
 * Stands in for `@/i18n/navigation` and for the one hook the application takes
 * from `next/navigation`. It imitates the library-facing surface — `Link`,
 * `useRouter`, `usePathname`, `useSearchParams` — so a behaviour test observes
 * the same calls the real router would receive.
 */

const ORIGIN = 'http://platform.test';

type Href = string | { pathname: string; query?: Record<string, unknown> };
type Options = { locale?: string };

export const pushSpy = vi.fn<(href: Href, options?: Options) => void>();
export const replaceSpy = vi.fn<(href: Href, options?: Options) => void>();
export const refreshSpy = vi.fn<() => void>();

let url = new URL('/', ORIGIN);
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function moveTo(href: Href) {
  url = new URL(serializeHref(href), ORIGIN);

  // The document's own address moves with the stub router, so a consumer that
  // reads `window.location` at event time and one that subscribes to
  // `usePathname` never see two different places.
  window.history.replaceState(
    null,
    '',
    `${url.pathname}${url.search}${url.hash}`,
  );

  for (const listener of listeners) listener();
}

/** The address the stub router currently sits at, path and query together. */
export function currentUrl(): string {
  return `${url.pathname}${url.search}`;
}

/** Places the reader at an address before a render, the way arrival would. */
export function stubLocation(at: string): void {
  moveTo(at);
}

/** What the library does internally before it reaches Next.js. */
function serializeHref(href: Href): string {
  if (typeof href === 'string') return href;

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(href.query ?? {})) {
    if (value !== undefined) query.set(key, String(value));
  }

  const search = query.toString();
  return search ? `${href.pathname}?${search}` : href.pathname;
}

export function Link({
  href,
  locale,
  children,
  ...rest
}: Omit<ComponentProps<'a'>, 'href'> & {
  href: Href;
  locale?: string;
  children?: ReactNode;
}) {
  const current = useLocale();
  const path = serializeHref(href);
  const prefix = locale ?? current;

  return (
    <a href={`/${prefix}${path === '/' ? '' : path}`} {...rest}>
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

export function useSearchParams(): URLSearchParams {
  const search = useSyncExternalStore(
    subscribe,
    () => url.search,
    () => url.search,
  );

  return new URLSearchParams(search);
}

const router = {
  // Arguments are forwarded exactly as the caller passed them, so a test can
  // tell `replace(href)` apart from `replace(href, { locale })`.
  push(...args: Parameters<typeof pushSpy>) {
    pushSpy(...args);
    moveTo(args[0]);
  },
  replace(...args: Parameters<typeof replaceSpy>) {
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
  pushSpy.mockReset();
  replaceSpy.mockReset();
  refreshSpy.mockReset();
  moveTo('/');
}
