import { registerAs } from '@nestjs/config';
import { z } from 'zod';

import {
  OriginConfigurationError,
  parseOrigin,
  resolveOrigins,
} from './origins.config';

export type GoogleAuthConfig = {
  clientId: string;
  clientSecret: string;
};

const baseSchema = z.object({
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, 'BETTER_AUTH_SECRET must be at least 32 characters long'),
  BETTER_AUTH_URL: z.url(),
  /**
   * The exact origins Better Auth will answer a browser request from. Exact
   * is the whole guarantee: every entry is parsed as an origin, so a value
   * carrying a path is refused rather than quietly compared against, and a
   * wildcard is refused outright. Better Auth matches parsed origins, and
   * nothing here adds prefix, suffix or pattern matching on top.
   */
  BETTER_AUTH_TRUSTED_ORIGINS: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string()).min(1))
    .transform((origins, context) => {
      const parsed: string[] = [];

      for (const origin of origins) {
        if (origin.includes('*')) {
          context.addIssue({
            code: 'custom',
            message:
              `BETTER_AUTH_TRUSTED_ORIGINS must list exact origins; ` +
              `"${origin}" is a pattern, and a pattern is not an allowlist`,
          });
          continue;
        }

        try {
          parsed.push(parseOrigin('BETTER_AUTH_TRUSTED_ORIGINS', origin));
        } catch (thrown) {
          context.addIssue({
            code: 'custom',
            message:
              thrown instanceof OriginConfigurationError
                ? `${thrown.message} (got "${origin}")`
                : `BETTER_AUTH_TRUSTED_ORIGINS entry "${origin}" is not an origin`,
          });
        }
      }

      return [...new Set(parsed)];
    }),

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
  const trustedOrigins = env.BETTER_AUTH_TRUSTED_ORIGINS;

  // A surface a browser holds a session on has to be trusted, or its sign-in
  // is refused at the origin check and the failure looks like anything but
  // configuration. Checked here rather than left to a first login: the API
  // origin is deliberately not in this set, because the API is talked to and
  // not browsed.
  const origins = resolveOrigins();

  for (const [name, origin] of [
    ['APP_ORIGIN_APP', origins.app],
    ...(origins.admin === null
      ? []
      : ([['APP_ORIGIN_ADMIN', origins.admin]] as const)),
  ] as readonly [string, string][]) {
    if (!trustedOrigins.includes(origin)) {
      throw new OriginConfigurationError(
        `${name} is ${origin}, which is not in BETTER_AUTH_TRUSTED_ORIGINS ` +
          `(${trustedOrigins.join(', ')}). A browser signing in from there ` +
          `would be refused by the origin check.`,
      );
    }
  }

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
    trustedOrigins,
    origins,
    rateLimitEnabled: env.BETTER_AUTH_RATE_LIMIT_ENABLED,
    google,
  };
});
