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
      // See `src/test/server-only.ts`: the real package throws by design, and
      // there is no client graph here for it to protect.
      'server-only': fileURLToPath(
        new URL('./src/test/server-only.ts', import.meta.url),
      ),
    },
  },

  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
