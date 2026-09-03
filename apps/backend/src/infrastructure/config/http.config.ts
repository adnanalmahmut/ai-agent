import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'staging', 'production'])
    .default('development'),
  RATE_LIMIT_ENABLED: z
    .preprocess(
      (value) => (value === '' ? undefined : value),
      z.enum(['true', 'false']).default('true'),
    )
    .transform((value) => value === 'true'),
  RATE_LIMIT_POINTS: z.coerce.number().int().min(1).max(100_000).default(60),
  RATE_LIMIT_DURATION_SEC: z.coerce
    .number()
    .int()
    .min(1)
    .max(86_400)
    .default(60),
  RATE_LIMIT_HEADER_PREFIX: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9-]{0,31}$/)
    .default('RateLimit'),
  RATE_LIMIT_REDIS_FAILURE_POLICY: z.enum(['open']).default('open'),
});

export default registerAs('http', () => {
  const env = schema.parse(process.env);
  const reverseProxyEnvironment =
    env.NODE_ENV === 'staging' || env.NODE_ENV === 'production';

  return {
    trustProxyHops: reverseProxyEnvironment ? 1 : 0,
    overwriteDirectIpHeaders: !reverseProxyEnvironment,
    rateLimit: {
      enabled: env.RATE_LIMIT_ENABLED,
      points: env.RATE_LIMIT_POINTS,
      durationSec: env.RATE_LIMIT_DURATION_SEC,
      headerPrefix: env.RATE_LIMIT_HEADER_PREFIX,
      redisFailurePolicy: env.RATE_LIMIT_REDIS_FAILURE_POLICY,
    },
  };
});
