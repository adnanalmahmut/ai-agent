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

// Nothing in this application may reach the network from a test. The auth
// client is stubbed where it is used; an unstubbed call has to fail loudly
// rather than quietly attempt a request.
vi.stubGlobal(
  'fetch',
  vi.fn(() => Promise.reject(new Error('Network access is disabled in tests'))),
);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
