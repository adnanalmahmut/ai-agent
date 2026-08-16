function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

/**
 * Values that are safe to ship in the browser bundle.
 *
 * Only display names belong here — and, after the move to a single origin, not
 * even a URL. A `VITE_` variable is compiled into the client bundle, so
 * anything put here is published, not configured. The backend owns
 * `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_SECRET` and `DATABASE_URL`, and none of
 * them has a public counterpart.
 *
 * The API's address is deliberately *not* here. It is a path on this same
 * origin, stated once in `config/paths.ts` — see the note there on why a fixed
 * deployment path is a worse environment variable than a constant.
 */
export const publicConfig = {
  appName: required('VITE_APP_NAME', import.meta.env.VITE_APP_NAME),
} as const;
