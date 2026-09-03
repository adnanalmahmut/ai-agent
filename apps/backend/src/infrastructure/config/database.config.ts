import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.url(),

  DATABASE_CONNECT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .default(5_000),
});

export default registerAs('database', () => {
  const env = schema.parse(process.env);
  return {
    url: env.DATABASE_URL,
    connectTimeoutMs: env.DATABASE_CONNECT_TIMEOUT_MS,
  };
});
