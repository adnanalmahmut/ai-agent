import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Test configuration, separate from `vite.config.ts` on purpose.
 *
 * The application config carries a `base` of `/platform/` and a dev proxy;
 * neither is meaningful under Vitest, and inheriting them would make the test
 * environment differ from the assertions in ways nobody would think to check.
 * What the tests do need is the same module resolution, so the alias is
 * repeated and nothing else is.
 */
export default defineConfig({
  plugins: [react()],

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
