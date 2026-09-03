import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'staging', 'production'])
    .default('development'),

  /**
   * Left unset on purpose so the default can depend on the environment.
   *
   * The generated documents enumerate every administrative and organization
   * endpoint the service exposes, so production defaults to off. An operator
   * who wants them can set the variable explicitly; nobody gets them by
   * forgetting to.
   */
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
    /** Served by `SwaggerModule`; also the first Scalar source. */
    jsonPath: '/openapi.json',
    /** Better Auth's own schema endpoint; the second Scalar source. */
    authSchemaPath: '/api/auth/open-api/generate-schema',
  };
});
