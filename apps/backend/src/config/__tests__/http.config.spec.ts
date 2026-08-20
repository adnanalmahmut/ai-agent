import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import httpConfig from '../http.config';

describe('httpConfig', () => {
  const original = process.env;

  beforeEach(() => {
    process.env = { ...original };
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = original;
  });

  it.each(['development', 'test'] as const)(
    'does not trust forwarded headers in %s',
    (environment) => {
      process.env.NODE_ENV = environment;

      expect(httpConfig()).toEqual({
        trustProxyHops: 0,
        overwriteDirectIpHeaders: true,
      });
    },
  );

  it.each(['staging', 'production'] as const)(
    'trusts exactly one proxy hop in %s',
    (environment) => {
      process.env.NODE_ENV = environment;

      expect(httpConfig()).toEqual({
        trustProxyHops: 1,
        overwriteDirectIpHeaders: false,
      });
    },
  );

  it('rejects an unknown environment rather than choosing a trust policy', () => {
    process.env.NODE_ENV = 'preview';

    expect(() => httpConfig()).toThrow();
  });
});
