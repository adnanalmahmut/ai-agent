import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  LOG_PRETTY: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .default(false),
});

export default registerAs('observability', () => {
  const env = schema.parse(process.env);

  return {
    level: env.LOG_LEVEL,
    pretty: env.LOG_PRETTY,
  };
});
