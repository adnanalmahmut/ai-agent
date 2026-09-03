import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'staging', 'production'])
    .default('development'),

  OPENAPI_ENABLED: z
    .preprocess(
      (value) => (value === '' ? undefined : value),
      z.enum(['true', 'false']).optional(),
    )
    .transform((value) => (value === undefined ? undefined : value === 'true')),

  OPENAPI_PATH: z
    .string()
    .startsWith('/', 'OPENAPI_PATH must start with "/"')
    .default('/docs'),
});

export default registerAs('openapi', () => {
  const env = schema.parse(process.env);

  return {
    enabled: env.OPENAPI_ENABLED ?? env.NODE_ENV !== 'production',
    path: env.OPENAPI_PATH,
    jsonPath: '/openapi.json',
    authSchemaPath: '/api/auth/open-api/generate-schema',
  };
});
