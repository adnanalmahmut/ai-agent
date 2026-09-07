import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

vi.mock('@/i18n/navigation', async () => import('@/test/navigation-stub'));

// The application reads search parameters straight from Next.js. The stub
// backs that hook with the same address its router moves, so a test sees one
// location rather than two that can disagree.
vi.mock('next/navigation', async () => {
  const actual =
    await vi.importActual<typeof import('next/navigation')>('next/navigation');
  const { useSearchParams } = await import('@/test/navigation-stub');

  return { ...actual, useSearchParams };
});

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

vi.stubGlobal(
  'fetch',
  vi.fn(() => Promise.reject(new Error('Network access is disabled in tests'))),
);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
