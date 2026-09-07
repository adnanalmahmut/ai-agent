import { afterEach, vi } from 'vitest';

/**
 * One setup for two environments. Most suites here are component tests and
 * want a DOM; the proxy and the session chain are server code and run under
 * `@vitest-environment node`, where touching `window` would fail before a
 * single test ran. So everything DOM-shaped is conditional on there being a
 * DOM, and everything else applies to both.
 */
const hasDom = typeof window !== 'undefined';

vi.mock('@/i18n/navigation', async () => import('@/test/navigation-stub'));

if (hasDom) {
  await import('@testing-library/jest-dom/vitest');

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
}

// Nothing in this application may reach the network from a test. The auth
// client is stubbed where it is used; an unstubbed call has to fail loudly
// rather than quietly attempt a request. The two suites that exist to test
// forwarding restore the real implementation for themselves.
vi.stubGlobal(
  'fetch',
  vi.fn(() => Promise.reject(new Error('Network access is disabled in tests'))),
);

afterEach(async () => {
  if (hasDom) {
    const { cleanup } = await import('@testing-library/react');
    cleanup();
  }

  vi.clearAllMocks();
});
