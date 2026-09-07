import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ADMIN_BASE_PATH,
  API_BASE_PATH,
  AUTH_BASE_PATH,
  BROWSER_AUTH_BASE_PATH,
} from '@/config/paths';

/**
 * Where this surface believes Better Auth is.
 *
 * Read from the source rather than by importing the client, because what
 * matters is that no origin is written down anywhere: a constant, an
 * environment variable or a fallback would each be a second answer to "which
 * origin owns this session", and the browser's own answer is the only correct
 * one.
 */

const source = readFileSync(
  join(process.cwd(), 'src/features/auth/auth-client.ts'),
  'utf8',
);

describe('the browser auth path', () => {
  it('is this application’s own auth path, not the deployment’s', () => {
    // The distinction is the whole point of the forwarding route: `/api/auth`
    // at the gateway is the Control Plane, and a browser request that landed
    // there would be cross-path rather than same-origin as far as this
    // surface's own boundary is concerned.
    expect(BROWSER_AUTH_BASE_PATH).toBe(`${ADMIN_BASE_PATH}${AUTH_BASE_PATH}`);
    expect(BROWSER_AUTH_BASE_PATH).toBe('/admin/api/auth');
    expect(AUTH_BASE_PATH.startsWith(API_BASE_PATH)).toBe(true);
  });

  it('is a path and not an origin', () => {
    for (const path of [ADMIN_BASE_PATH, AUTH_BASE_PATH, BROWSER_AUTH_BASE_PATH]) {
      expect(path.startsWith('/')).toBe(true);
      expect(path).not.toMatch(/:\/\//);
      expect(path.endsWith('/')).toBe(false);
    }
  });
});

describe('the auth client', () => {
  it('takes its origin from the browser', () => {
    expect(source).toContain('window.location.origin');
    expect(source).toContain('BROWSER_AUTH_BASE_PATH');
  });

  it('names no origin of its own', () => {
    // `http://localhost` appears once, for the server-side render where there
    // is no window and nothing is ever fetched.
    const origins = source.match(/https?:\/\/[^'"`\s)]+/g) ?? [];

    expect(origins).toEqual(['http://localhost']);
  });

  it('reads no origin from the environment', () => {
    expect(source).not.toContain('process.env');
  });
});
