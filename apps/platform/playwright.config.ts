import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

import { PLATFORM_BASE_PATH } from './src/config/paths.js';

/**
 * A deliberately small browser smoke harness.
 *
 * ## What it is for
 *
 * The component suite runs in jsdom, which is a good enough DOM to assert
 * behaviour against and is not a browser. Four things this application depends
 * on are simply absent there: real navigation and history, `sessionStorage`
 * with its real lifetime, the `crypto` subtle and `randomUUID` APIs in a secure
 * context, and the bundle actually being buildable and bootable. Every one of
 * them is load-bearing for the content-idea flow — the operation lives in the
 * URL, the idempotency key lives in session storage, the key is minted with
 * `randomUUID`, and what is stored beside it is a `crypto.subtle` digest of the
 * request rather than the request.
 *
 * ## What it is not
 *
 * Not a second functional suite. Everything about *logic* is asserted in the
 * component tests, which are faster and can see inside the component; the cases
 * here are the ones that need a browser to mean anything. There is one spec
 * file, and it should stay that way.
 *
 * ## Why one browser
 *
 * Chromium only. This is a smoke harness for behaviour the application owns,
 * not a compatibility matrix — and three browsers would triple the CI time to
 * re-assert the same assertions against the same code.
 *
 * ## No provider, no backend
 *
 * Every network call is fulfilled by `page.route` from fixtures in the spec.
 * That is what keeps the suite deterministic and keeps a browser test from
 * needing a database, a queue, and a credential — which is the reason browser
 * suites get deleted.
 */

const PORT = Number(process.env.PLATFORM_E2E_PORT ?? 4173);
const PLATFORM_ROOT = fileURLToPath(new URL('.', import.meta.url));
const VITE_CLI = fileURLToPath(
  new URL('./node_modules/vite/bin/vite.js', import.meta.url),
);
const USE_EXTERNAL_SERVER = process.env.PLATFORM_E2E_EXTERNAL_SERVER === 'true';

export default defineConfig({
  testDir: './e2e',
  /**
   * Fully serial. The suite is small, the cases share no state, and a parallel
   * run buys seconds while making a flake harder to reproduce.
   */
  workers: 1,
  fullyParallel: false,
  /**
   * No retries. A browser test that passes on the second attempt is a test
   * nobody can trust, and retries are how that becomes invisible.
   */
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI === undefined ? 'list' : [['list'], ['github']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}${PLATFORM_BASE_PATH}/`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  /**
   * The built application, served the way production serves it.
   *
   * `vite preview` rather than the dev server, because the thing worth knowing
   * is that the *bundle* boots — a dev server can serve an application whose
   * production build fails. It also honours `base`, so the router's basename
   * is exercised rather than bypassed.
   */
  webServer: USE_EXTERNAL_SERVER
    ? undefined
    : {
        // Invoke the committed local binary directly. Under a filtered pnpm
        // script, `npx` delegates to npm and can spend the entire readiness
        // window resolving a package it already has locally.
        command: `node ${JSON.stringify(VITE_CLI)} preview ${JSON.stringify(PLATFORM_ROOT)} --host 127.0.0.1 --port ${PORT} --strictPort`,
        // Playwright inherits the command's caller directory, which is the
        // workspace root in CI. Pin this to the package so the local Vite path
        // is deterministic.
        cwd: PLATFORM_ROOT,
        url: `http://127.0.0.1:${PORT}${PLATFORM_BASE_PATH}/`,
        reuseExistingServer: process.env.CI === undefined,
        timeout: 120_000,
      },
});
