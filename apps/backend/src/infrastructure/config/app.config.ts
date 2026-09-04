import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * The name used when `APP_NAME` is unset. Exported because OpenAPI type
 * generation builds the document without the configuration module — it has no
 * environment to read — and still has to title the document the same way.
 */
export const DEFAULT_APPLICATION_NAME = 'API Service';

const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'staging', 'production'])
    .default('development'),

  APP_PORT: z.coerce.number().int().min(1).max(65535).default(3001),

  APP_NAME: z.string().default(DEFAULT_APPLICATION_NAME),

  APP_PLATFORM_URL: z.url().default('http://localhost:3001/platform'),

  APP_SHUTDOWN_READINESS_DELAY_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(60_000)
    .default(0),

  APP_SHUTDOWN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .default(30_000),
});

export default registerAs('app', () => {
  const env = schema.parse(process.env);

  return {
    env: env.NODE_ENV,
    port: env.APP_PORT,
    name: env.APP_NAME,
    // Trailing slash removed once, here, so every consumer can concatenate.
    platformUrl: env.APP_PLATFORM_URL.replace(/\/+$/, ''),
    shutdown: {
      readinessDelayMs: env.APP_SHUTDOWN_READINESS_DELAY_MS,
      timeoutMs: env.APP_SHUTDOWN_TIMEOUT_MS,
    },
  };
});
