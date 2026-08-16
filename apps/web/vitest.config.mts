import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // next-intl's client navigation entry does a bare `next/navigation`
      // import, which only resolves through the Next.js bundler. Pointing at
      // the published file keeps these tests runnable in plain Node.
      'next/navigation': 'next/navigation.js',
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    server: {
      // Without inlining, next-intl is externalised and Node resolves its
      // imports itself — which skips the alias above.
      deps: { inline: ['next-intl'] },
    },
  },
});
