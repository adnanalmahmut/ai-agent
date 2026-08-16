import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/**
 * Shared test environment.
 *
 * `VITE_APP_NAME` is read at module scope by the public configuration, which
 * the auth client imports — so it has to exist before any import of it is
 * evaluated. A `beforeEach` would be too late.
 */
import.meta.env.VITE_APP_NAME ??= 'AI Agents';

/**
 * jsdom implements none of these, and Radix's dropdowns, dialogs and sheets
 * call all of them. Without the stubs every menu test fails on the
 * environment rather than on the component.
 */
if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}

/**
 * Radix's Select drives its trigger with Pointer Events, which jsdom does not
 * implement. Without these the menu never opens and every test about choosing
 * a role fails on the environment rather than on the component.
 */
for (const method of [
  'hasPointerCapture',
  'setPointerCapture',
  'releasePointerCapture',
] as const) {
  if (!Element.prototype[method]) {
    Element.prototype[method] = vi.fn() as never;
  }
}

if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

/**
 * No test reaches the network.
 *
 * The application makes exactly one kind of `fetch` — the archived-organization
 * read through `lib/application-api` — and a test that hit it for real would
 * be slow, flaky and dependent on a running backend. Failing loudly here is
 * better than a request that quietly resolves against whatever is listening on
 * the developer's machine. Tests that care about that call replace the module.
 */
vi.stubGlobal(
  'fetch',
  vi.fn(() =>
    Promise.reject(new Error('Network access is disabled in tests')),
  ),
);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
