import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

import { PLATFORM_BASE_PATH } from './src/config/paths.js';

const PORT = Number(process.env.PLATFORM_E2E_PORT ?? 4173);
const API_PORT = Number(process.env.PLATFORM_E2E_API_PORT ?? 4174);
const PLATFORM_ROOT = fileURLToPath(new URL('.', import.meta.url));
const USE_EXTERNAL_SERVER = process.env.PLATFORM_E2E_EXTERNAL_SERVER === 'true';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI === undefined ? 'list' : [['list'], ['github']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}${PLATFORM_BASE_PATH}/`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: USE_EXTERNAL_SERVER
    ? undefined
    : [
        {
          command: `node e2e/fixture-server.mjs`,
          cwd: PLATFORM_ROOT,
          env: { PLATFORM_E2E_API_PORT: String(API_PORT) },
          url: `http://127.0.0.1:${API_PORT}/health`,
          reuseExistingServer: process.env.CI === undefined,
          timeout: 30_000,
        },
        {
          command: 'node .next/standalone/apps/platform/server.js',
          cwd: PLATFORM_ROOT,
          env: {
            HOSTNAME: '127.0.0.1',
            PORT: String(PORT),
            PLATFORM_API_ORIGIN: `http://127.0.0.1:${API_PORT}`,
          },
          url: `http://127.0.0.1:${PORT}${PLATFORM_BASE_PATH}/health`,
          reuseExistingServer: process.env.CI === undefined,
          timeout: 120_000,
        },
      ],
});
