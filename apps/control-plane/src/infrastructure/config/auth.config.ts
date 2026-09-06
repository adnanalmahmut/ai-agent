import { registerAs } from '@nestjs/config';
import { z } from 'zod';

export type GoogleAuthConfig = {
  clientId: string;
  clientSecret: string;
};

const baseSchema = z.object({
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, 'BETTER_AUTH_SECRET must be at least 32 characters long'),
  BETTER_AUTH_URL: z.url(),
  BETTER_AUTH_TRUSTED_ORIGINS: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.url()).min(1)),

  GOOGLE_AUTH_ENABLED: z
    .preprocess(
      (value) => (value === '' ? undefined : value),
      z.enum(['true', 'false']).default('false'),
    )
    .transform((value) => value === 'true'),
  BETTER_AUTH_RATE_LIMIT_ENABLED: z
    .preprocess(
      (value) => (value === '' ? undefined : value),
      z.enum(['true', 'false']).optional(),
    )
    .transform((value) =>
      value === undefined ? process.env.NODE_ENV !== 'test' : value === 'true',
    ),
});

const googleSchema = z.object({
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
});

export default registerAs('auth', () => {
  const env = baseSchema.parse(process.env);

  const google: GoogleAuthConfig | null = env.GOOGLE_AUTH_ENABLED
    ? (() => {
        const credentials = googleSchema.parse(process.env);
        return {
          clientId: credentials.GOOGLE_CLIENT_ID,
          clientSecret: credentials.GOOGLE_CLIENT_SECRET,
        };
      })()
    : null;

  return {
    secret: env.BETTER_AUTH_SECRET,
    baseUrl: env.BETTER_AUTH_URL,
    trustedOrigins: env.BETTER_AUTH_TRUSTED_ORIGINS,
    rateLimitEnabled: env.BETTER_AUTH_RATE_LIMIT_ENABLED,
    google,
  };
});
