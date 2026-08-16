import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * Credentials for the Google social provider.
 *
 * Null when the feature is switched off — the same discriminated shape the
 * mail configuration uses, so an inactive provider's environment is never
 * required and an active one's is never optional.
 */
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
});

/**
 * Parsed only when Google is switched on.
 *
 * `.min(1)` rather than a bare string: a commented-out `.env` line leaves the
 * variable absent, but an emptied one leaves it present and empty, and an
 * empty client secret would otherwise reach Google as a silent authentication
 * failure at the first sign-in instead of a loud failure at boot.
 */
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
    google,
  };
});
