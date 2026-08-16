import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.url(),
});

export default registerAs('database', () => {
  const env = schema.parse(process.env);
  return {
    url: env.DATABASE_URL,
  };
});
