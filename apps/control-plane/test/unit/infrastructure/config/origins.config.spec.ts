import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import authConfig from '../../../../src/infrastructure/config/auth.config';
import {
  OriginConfigurationError,
  parseOrigin,
  resolveOrigins,
} from '../../../../src/infrastructure/config/origins.config';

/**
 * The origin model is a security boundary made of string comparisons, so what
 * matters is exactly which strings compare equal. Everything below is either
 * a normalisation that must hold or a near-miss that must not.
 */

const SECRET = 'test-only-better-auth-secret-000000000000';

describe('parseOrigin', () => {
  it.each([
    [
      'a plain https origin',
      'https://app.example.com',
      'https://app.example.com',
    ],
    ['a trailing slash', 'https://app.example.com/', 'https://app.example.com'],
    [
      'an explicit port',
      'https://app.example.com:8443',
      'https://app.example.com:8443',
    ],
    ['a localhost port', 'http://localhost:3001', 'http://localhost:3001'],
    // Scheme and host are case-insensitive; a comparison that did not
    // normalise them would treat these as different origins.
    ['mixed case', 'HTTPS://App.Example.COM', 'https://app.example.com'],
    // The default port is not part of an origin's serialisation.
    [
      'a redundant default port',
      'https://app.example.com:443',
      'https://app.example.com',
    ],
  ])('normalises %s', (_case, input, expected) => {
    expect(parseOrigin('ORIGIN', input)).toBe(expected);
  });

  it.each([
    ['a path', 'https://app.example.com/platform'],
    ['a query', 'https://app.example.com?a=1'],
    ['a fragment', 'https://app.example.com#x'],
    ['embedded credentials', 'https://user:pass@app.example.com'],
    ['a userinfo host trick', 'https://app.example.com@attacker.example'],
    ['no scheme', 'app.example.com'],
    ['a protocol-relative value', '//app.example.com'],
    ['a wildcard', 'https://*.example.com'],
    ['a bare wildcard', '*'],
    ['a non-web scheme', 'ftp://app.example.com'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,x'],
    ['an empty value', ''],
    ['whitespace', '   '],
  ])('refuses %s', (_case, input) => {
    expect(() => parseOrigin('ORIGIN', input)).toThrow(
      OriginConfigurationError,
    );
  });

  it('does not treat a suffix as a match', () => {
    // The lookalike is a different host, and the only thing standing between
    // the two is that this is parsing rather than string comparison.
    expect(
      parseOrigin('ORIGIN', 'https://app.example.com.attacker.example'),
    ).toBe('https://app.example.com.attacker.example');
    expect(parseOrigin('ORIGIN', 'https://app.example.com')).not.toBe(
      parseOrigin('ORIGIN', 'https://app.example.com.attacker.example'),
    );
  });
});

describe('resolveOrigins', () => {
  it('derives the app and API origins from the settings already in use', () => {
    // Nothing new has to be configured for the model to be correct: the
    // running system already behaves according to these two.
    expect(
      resolveOrigins({
        APP_PLATFORM_URL: 'https://www.example.com/platform',
        BETTER_AUTH_URL: 'https://www.example.com/api/auth',
      }),
    ).toEqual({
      public: 'https://www.example.com',
      app: 'https://www.example.com',
      admin: null,
      api: 'https://www.example.com',
    });
  });

  it('keeps local public origin while deriving deployment public origin from the app', () => {
    expect(resolveOrigins({})).toEqual({
      public: 'http://localhost:3000',
      app: 'http://localhost:3001',
      admin: null,
      api: 'http://localhost:3002',
    });

    expect(
      resolveOrigins({
        APP_PLATFORM_URL: 'https://staging.feedogo.com/platform',
        BETTER_AUTH_URL: 'https://staging.feedogo.com/api/auth',
      }),
    ).toEqual({
      public: 'https://staging.feedogo.com',
      app: 'https://staging.feedogo.com',
      admin: null,
      api: 'https://staging.feedogo.com',
    });
  });

  it.each([
    ['', '', '', ''],
    [' ', '\t', '\n', '  \t  '],
  ])('treats blank APP_ORIGIN_* values as unset', (...values) => {
    expect(
      resolveOrigins({
        APP_PLATFORM_URL: 'https://staging.feedogo.com/platform',
        BETTER_AUTH_URL: 'https://staging.feedogo.com/api/auth',
        APP_ORIGIN_PUBLIC: values[0],
        APP_ORIGIN_APP: values[1],
        APP_ORIGIN_ADMIN: values[2],
        APP_ORIGIN_API: values[3],
      }),
    ).toEqual({
      public: 'https://staging.feedogo.com',
      app: 'https://staging.feedogo.com',
      admin: null,
      api: 'https://staging.feedogo.com',
    });
  });

  it('keeps non-empty APP_ORIGIN_* values strict', () => {
    expect(() =>
      resolveOrigins({
        APP_PLATFORM_URL: 'https://staging.feedogo.com/platform',
        APP_ORIGIN_PUBLIC: 'not-an-origin',
      }),
    ).toThrow(OriginConfigurationError);

    expect(() =>
      resolveOrigins({
        APP_PLATFORM_URL: 'https://staging.feedogo.com/platform',
        APP_ORIGIN_ADMIN: 'https://*.example.com',
      }),
    ).toThrow(OriginConfigurationError);
  });

  it('accepts the single-host staging origin on every path-based surface', () => {
    expect(
      resolveOrigins({
        APP_ORIGIN_PUBLIC: 'https://staging.feedogo.com',
        APP_ORIGIN_APP: 'https://staging.feedogo.com',
        APP_ORIGIN_ADMIN: 'https://staging.feedogo.com',
        APP_ORIGIN_API: 'https://staging.feedogo.com',
        APP_PLATFORM_URL: 'https://staging.feedogo.com/platform',
        BETTER_AUTH_URL: 'https://staging.feedogo.com/api/auth',
        BETTER_AUTH_TRUSTED_ORIGINS: 'https://staging.feedogo.com',
      }),
    ).toEqual({
      public: 'https://staging.feedogo.com',
      app: 'https://staging.feedogo.com',
      admin: 'https://staging.feedogo.com',
      api: 'https://staging.feedogo.com',
    });
  });

  it.each([
    ['credentials', 'https://user:pass@app.example.com/platform'],
    ['wildcard hostname', 'https://*.example.com/platform'],
    ['authority trick', 'https://app.example.com@evil.example/...'],
    ['non-http scheme', 'ftp://app.example.com/platform'],
  ])('rejects unsafe path-bearing canonical URL with %s', (_case, value) => {
    expect(() => resolveOrigins({ APP_PLATFORM_URL: value })).toThrow(
      OriginConfigurationError,
    );
  });

  it.each([
    'https://staging.feedogo.com/platform',
    'https://staging.feedogo.com/api/auth',
  ])('accepts safe path-bearing canonical URL %s', (value) => {
    expect(resolveOrigins({ APP_PLATFORM_URL: value }).app).toBe(
      'https://staging.feedogo.com',
    );
  });

  it('accepts one host serving every surface, which is the deployment today', () => {
    const origins = resolveOrigins({
      APP_PLATFORM_URL: 'https://staging.invalid/platform',
      BETTER_AUTH_URL: 'https://staging.invalid/api/auth',
      APP_ORIGIN_PUBLIC: 'https://staging.invalid',
    });

    expect(origins.public).toBe('https://staging.invalid');
    expect(origins.app).toBe('https://staging.invalid');
    expect(origins.api).toBe('https://staging.invalid');
  });

  it('accepts a surface per hostname, which is where this is going', () => {
    expect(
      resolveOrigins({
        APP_PLATFORM_URL: 'https://app.example.com/platform',
        BETTER_AUTH_URL: 'https://api.example.com/api/auth',
        APP_ORIGIN_PUBLIC: 'https://example.com',
        APP_ORIGIN_APP: 'https://app.example.com',
        APP_ORIGIN_ADMIN: 'https://admin.example.com',
        APP_ORIGIN_API: 'https://api.example.com',
      }),
    ).toEqual({
      public: 'https://example.com',
      app: 'https://app.example.com',
      admin: 'https://admin.example.com',
      api: 'https://api.example.com',
    });
  });

  it('leaves the admin origin unset rather than inventing one', () => {
    // No deployment serves it yet, and an invented value would become an
    // allowlist entry for an origin that does not exist.
    expect(resolveOrigins({}).admin).toBeNull();
  });

  it.each([
    [
      'the app origin contradicts APP_PLATFORM_URL',
      {
        APP_PLATFORM_URL: 'https://app.example.com/platform',
        APP_ORIGIN_APP: 'https://other.example.com',
      },
    ],
    [
      'the API origin contradicts BETTER_AUTH_URL',
      {
        BETTER_AUTH_URL: 'https://api-a.example.com/api/auth',
        APP_ORIGIN_API: 'https://api-b.example.com',
      },
    ],
    [
      'the app origin differs only by scheme',
      {
        APP_PLATFORM_URL: 'https://app.example.com/platform',
        APP_ORIGIN_APP: 'http://app.example.com',
      },
    ],
    [
      'the app origin differs only by port',
      {
        APP_PLATFORM_URL: 'https://app.example.com/platform',
        APP_ORIGIN_APP: 'https://app.example.com:8443',
      },
    ],
  ])('refuses configuration where %s', (_case, environment) => {
    expect(() => resolveOrigins(environment)).toThrow(OriginConfigurationError);
  });

  it('accepts an explicit value that agrees with what it is derived from', () => {
    expect(
      resolveOrigins({
        APP_PLATFORM_URL: 'https://app.example.com/platform',
        // Same origin, written with a trailing slash and different case.
        APP_ORIGIN_APP: 'HTTPS://App.Example.com/',
      }).app,
    ).toBe('https://app.example.com');
  });
});

describe('the trusted-origin allowlist', () => {
  const original = process.env;

  beforeEach(() => {
    process.env = {
      ...original,
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: 'https://www.example.com/api/auth',
      APP_PLATFORM_URL: 'https://www.example.com/platform',
      BETTER_AUTH_TRUSTED_ORIGINS: 'https://www.example.com',
      GOOGLE_AUTH_ENABLED: 'false',
    };
    delete process.env.APP_ORIGIN_ADMIN;
    delete process.env.APP_ORIGIN_APP;
    delete process.env.APP_ORIGIN_API;
  });

  afterEach(() => {
    process.env = original;
  });

  it('parses every entry as an origin and de-duplicates', () => {
    process.env.BETTER_AUTH_TRUSTED_ORIGINS =
      'https://www.example.com/, HTTPS://WWW.example.com , https://admin.example.com';
    process.env.APP_ORIGIN_ADMIN = 'https://admin.example.com';

    expect(authConfig().trustedOrigins).toEqual([
      'https://www.example.com',
      'https://admin.example.com',
    ]);
  });

  it.each([
    ['a bare wildcard', '*'],
    ['a subdomain wildcard', 'https://*.example.com'],
    [
      'a wildcard beside a real origin',
      'https://www.example.com,https://*.example.com',
    ],
  ])('refuses %s, because a pattern is not an allowlist', (_case, value) => {
    process.env.BETTER_AUTH_TRUSTED_ORIGINS = value;

    expect(() => authConfig()).toThrow();
  });

  it.each([
    ['an entry with a path', 'https://www.example.com/platform'],
    ['an entry with no scheme', 'www.example.com'],
    ['an empty list', ','],
  ])('refuses %s', (_case, value) => {
    process.env.BETTER_AUTH_TRUSTED_ORIGINS = value;

    expect(() => authConfig()).toThrow();
  });

  it('refuses a deployment whose app origin is not trusted', () => {
    // Otherwise every sign-in is refused by the origin check and the failure
    // looks like anything except configuration.
    process.env.BETTER_AUTH_TRUSTED_ORIGINS = 'https://elsewhere.example.com';

    expect(() => authConfig()).toThrow(OriginConfigurationError);
  });

  it('refuses a configured admin origin that is not trusted', () => {
    process.env.APP_ORIGIN_ADMIN = 'https://admin.example.com';

    expect(() => authConfig()).toThrow(OriginConfigurationError);
  });

  it('does not require an admin origin nobody configured', () => {
    expect(authConfig().trustedOrigins).toEqual(['https://www.example.com']);
    expect(authConfig().origins.admin).toBeNull();
  });

  it('does not put the API origin in the allowlist on its own', () => {
    // A single-host deployment has the API on the same origin as the app, so
    // it is there by consequence. Nothing adds it because it is the API.
    process.env.BETTER_AUTH_URL = 'https://api.example.com/api/auth';
    process.env.BETTER_AUTH_TRUSTED_ORIGINS = 'https://www.example.com';

    const config = authConfig();

    expect(config.origins.api).toBe('https://api.example.com');
    expect(config.trustedOrigins).not.toContain('https://api.example.com');
  });
});
