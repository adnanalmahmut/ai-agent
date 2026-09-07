import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { API_BASE_PATH, AUTH_BASE_PATH } from '@/config/paths';

/**
 * Authentication happens on the origin the reader is already on.
 *
 * The session cookie is `__Host-`-prefixed, which a browser will only accept
 * as belonging to the exact origin that set it. So the sign-in request has to
 * be made to that same origin and forwarded server-side — in production by the
 * gateway, which serves `/api/` from the same host as the application, and in
 * development by the Next rewrite. Pointing the auth client at the API's own
 * origin instead would put the cookie on a host the reader never visits, and
 * the reader would be signed in to nothing.
 *
 * That is a property of one line in one module, and it is the kind of line
 * somebody changes to "fix" a local setup, so it is asserted here rather than
 * left to a comment.
 */

const authClientSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'auth-client.ts'),
  'utf8',
);

describe('the auth client', () => {
  it('builds its base URL from the current origin', () => {
    expect(authClientSource).toContain('window.location.origin');
  });

  it('names no origin of its own', () => {
    // Any absolute http(s) URL here would be a second, cross-origin answer to
    // where authentication lives. The one literal allowed is the server-side
    // placeholder `URL` needs to resolve a relative path against.
    const absolute = [
      ...authClientSource.matchAll(/['"`](https?:\/\/[^'"`]+)['"`]/g),
    ].map((match) => match[1]);

    expect(absolute).toEqual(['http://localhost']);
  });

  it('reaches the API through a same-origin path, not a host', () => {
    expect(AUTH_BASE_PATH.startsWith(API_BASE_PATH)).toBe(true);
    expect(AUTH_BASE_PATH.startsWith('/')).toBe(true);
    expect(API_BASE_PATH.startsWith('/')).toBe(true);
  });

  it('does not read an origin out of the environment', () => {
    // A configurable auth origin is a configurable cookie host. There is no
    // deployment in which those should differ from where the page came from.
    expect(authClientSource).not.toContain('process.env');
  });
});
