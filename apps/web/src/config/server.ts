import 'server-only';
import { z } from 'zod';

const serverEnvSchema = z.object({
  APP_ENV: z
    .enum(['development', 'staging', 'production'])
    .default('development'),
});

const env = serverEnvSchema.parse({
  APP_ENV: process.env.APP_ENV,
});

export const serverConfig = {
  environment: env.APP_ENV,
} as const;
