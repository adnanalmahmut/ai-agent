import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import proxy from './proxy';

function request(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(`https://internal.test${path}`, {
    headers: { host: 'platform.example', ...headers },
    nextConfig: { basePath: '/platform' },
  });
}

describe('the platform locale proxy', () => {
  it('passes a supported localized route through without rewriting it', () => {
    const response = proxy(request('/platform/en/organizations'));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('forwards the interrupted deep link to the protected layout', () => {
    const response = proxy(
      request('/platform/en/organizations/org_1/members?tab=active'),
    );

    expect(
      response.headers.get('x-middleware-request-x-platform-return-to'),
    ).toBe('/platform/en/organizations/org_1/members?tab=active');
  });

  it('records the URL locale as a preference cookie', () => {
    const response = proxy(request('/platform/ar'));

    expect(response.cookies.get('APP_LOCALE')?.value).toBe('ar');
    expect(response.headers.get('set-cookie')).toContain('Path=/');
  });

  it('redirects a bare mount point to the default locale', () => {
    const response = proxy(request('/platform'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://platform.example/platform/ar',
    );
  });

  it('preserves a locale-less deep link and query string', () => {
    const response = proxy(request('/platform/organizations?tab=active'));

    expect(response.headers.get('location')).toBe(
      'https://platform.example/platform/ar/organizations?tab=active',
    );
  });

  it('does not pretend an unsupported locale is supported', () => {
    const response = proxy(request('/platform/fr/organizations'));

    expect(response.headers.get('location')).toBe(
      'https://platform.example/platform/ar/fr/organizations',
    );
  });

  it('honors the trusted proxy origin when constructing a redirect', () => {
    const response = proxy(
      request('/platform', {
        'x-forwarded-host': 'app.example.test',
        'x-forwarded-proto': 'https',
      }),
    );

    expect(response.headers.get('location')).toBe(
      'https://app.example.test/platform/ar',
    );
  });
});
