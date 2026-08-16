import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Extension included so Vite's native config loader can resolve it without
// a bundling step; TypeScript maps `.js` back to the `.ts` source.
import { API_BASE_PATH, PLATFORM_BASE_PATH } from './src/config/paths.js';

/**
 * Where the dev server forwards `/api` to.
 *
 * Not a `VITE_` variable, and that distinction is the point: `VITE_*` values
 * are compiled into the browser bundle, and this one is read by the dev
 * server process only. Production never uses it at all — there the reverse
 * proxy owns the same rule.
 */
const API_PROXY_TARGET =
  process.env.PLATFORM_API_PROXY_TARGET ?? 'http://localhost:3002';

const PORT = Number(process.env.PLATFORM_PORT ?? 3001);

/**
 * Vite configuration for a static SPA served from `/platform/`.
 *
 * Two settings carry most of the weight.
 *
 * `base` makes every emitted asset URL absolute under `/platform/`, so the
 * reverse proxy can route by prefix without rewriting HTML. Leaving it at `/`
 * would produce `<script src="/assets/…">` and the proxy would hand those
 * requests to the marketing application.
 *
 * The dev `proxy` reproduces the production topology on localhost: the browser
 * only ever talks to this origin, and `/api` is forwarded behind the scenes.
 * That is what keeps development free of the cross-origin cookie and CORS
 * behaviour production will never have — a difference that otherwise only
 * shows up after deploying.
 */
export default defineConfig({
  base: `${PLATFORM_BASE_PATH}/`,

  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  server: {
    port: PORT,
    proxy: {
      [API_BASE_PATH]: {
        target: API_PROXY_TARGET,
        changeOrigin: false,
      },
    },
  },

  // `vite preview` serves the production build; it needs the same forwarding
  // so the built artifact can be exercised before it reaches a real proxy.
  preview: {
    port: PORT,
    proxy: {
      [API_BASE_PATH]: {
        target: API_PROXY_TARGET,
        changeOrigin: false,
      },
    },
  },

  build: {
    // Source maps for a private dashboard: the bundle holds no secret, and a
    // production stack trace that names a real file is worth far more than
    // the obscurity of one that does not.
    sourcemap: true,
  },
});
