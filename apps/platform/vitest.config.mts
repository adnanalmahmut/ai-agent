import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Vitest owns its test transform and module resolution independently of the
 * Next.js application build. The alias mirrors tsconfig so tests exercise the
 * same imports without pulling a second application bundler into the package.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  test: {
    // Component tests need a DOM; the pure modules do not care either way, so
    // one environment for the whole suite beats per-file annotations.
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
