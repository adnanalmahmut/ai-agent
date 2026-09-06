import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  REDIS_URL: z.url({
    protocol: /^rediss?$/,
    error: 'REDIS_URL must be a redis:// or rediss:// URL',
  }),

  REDIS_KEY_PREFIX: z
    .string()
    .regex(
      /^[A-Za-z0-9_:-]+$/,
      'REDIS_KEY_PREFIX may contain only letters, digits, "_", ":" and "-"',
    )
    .default('app'),

  REDIS_CONNECT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .default(5_000),

  REDIS_COMMAND_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(30_000)
    .default(2_000),

  REDIS_MAX_RETRIES_PER_REQUEST: z.coerce
    .number()
    .int()
    .min(1)
    .max(3)
    .default(2),
});

export default registerAs('redis', () => {
  const env = schema.parse(process.env);

  return {
    url: env.REDIS_URL,
    keyPrefix: `${env.REDIS_KEY_PREFIX}:`,
    connectTimeoutMs: env.REDIS_CONNECT_TIMEOUT_MS,
    commandTimeoutMs: env.REDIS_COMMAND_TIMEOUT_MS,
    maxRetriesPerRequest: env.REDIS_MAX_RETRIES_PER_REQUEST,
  };
});
