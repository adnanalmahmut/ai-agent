import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

vi.mock('@/i18n/navigation', async () => import('@/test/navigation-stub'));

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
