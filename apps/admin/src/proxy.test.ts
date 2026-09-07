// @vitest-environment node
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import proxy from './proxy';
import { ADMIN_BASE_PATH } from './config/paths';

/**
 * This application is mounted at a path, and Next.js hands middleware a URL
 * that still carries that path while matching the pattern above against a URL
 * that does not. Every case here is about that seam: a redirect built without
 * accounting for it sends the reader to a locale prefix in front of the mount
 * point, which is a 404 the tests below would otherwise not notice.
 */

const request = (
  path: string,
  headers: Record<string, string> = {},
) =>
  new NextRequest(`http://internal.test${path}`, {
    headers: { host: 'staging.example.test', ...headers },
    nextConfig: { basePath: ADMIN_BASE_PATH },
  });

const locationOf = (path: string, headers?: Record<string, string>) =>
  new URL(proxy(request(path, headers)).headers.get('location') as string);

describe('a request that names no locale', () => {
  it.each([
    ['the mount point itself', ADMIN_BASE_PATH, '/admin/ar'],
    ['a path under it', '/admin/login', '/admin/ar/login'],
    ['a nested path', '/admin/settings/mail', '/admin/ar/settings/mail'],
  ])('sends %s to the default locale beneath the mount point', (
    _case,
    path,
    expected,
  ) => {
    expect(locationOf(path).pathname).toBe(expected);
  });

  it('keeps the query string', () => {
    const destination = locationOf('/admin/login?next=%2Fadmin%2Far');

    expect(destination.pathname).toBe('/admin/ar/login');
    expect(destination.search).toBe('?next=%2Fadmin%2Far');
  });

  it('never puts the locale in front of the mount point', () => {
    // The bug this exists to catch: `/ar/admin/...` is not served by anything.
    expect(locationOf('/admin/login').pathname).not.toMatch(/^\/[a-z]{2}\//);
  });

  it('names the origin the reader is on, not the one the gateway dialled', () => {
    const destination = locationOf('/admin/login', {
      host: '127.0.0.1:3003',
      'x-forwarded-host': 'staging.example.test',
      'x-forwarded-proto': 'https',
    });

    expect(destination.origin).toBe('https://staging.example.test');
  });

  it('takes the first value of a forwarded list', () => {
    const destination = locationOf('/admin/login', {
      host: '127.0.0.1:3003',
      'x-forwarded-host': 'staging.example.test, internal.example.test',
      'x-forwarded-proto': 'https, http',
    });

    expect(destination.origin).toBe('https://staging.example.test');
  });
});

describe('a request that names a locale', () => {
  it.each([
    ['/admin/ar', 'ar'],
    ['/admin/en', 'en'],
    ['/admin/en/login', 'en'],
  ])('%s is served rather than redirected', (path, locale) => {
    const response = proxy(request(path));

    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-middleware-request-x-next-intl-locale')).toBe(
      locale,
    );
  });

  it('remembers the language for the whole host, and only the language', () => {
    const cookie = proxy(request('/admin/en')).cookies.get('APP_LOCALE');

    expect(cookie?.value).toBe('en');
    expect(cookie?.path).toBe('/');
    // A session is not set here and never will be: this decides no access.
    expect(proxy(request('/admin/en')).cookies.get('__Host-session')).toBeUndefined();
  });
});
