import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import httpConfig from '../../../../src/infrastructure/config/http.config';

const DEFAULT_RATE_LIMIT = {
  enabled: true,
  points: 60,
  durationSec: 60,
  headerPrefix: 'RateLimit',
  redisFailurePolicy: 'open',
};

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
        rateLimit: DEFAULT_RATE_LIMIT,
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
        rateLimit: DEFAULT_RATE_LIMIT,
      });
    },
  );

  it('rejects an unknown environment rather than choosing a trust policy', () => {
    process.env.NODE_ENV = 'preview';

    expect(() => httpConfig()).toThrow();
  });

  it('parses explicit rate-limit values without treating false as truthy', () => {
    process.env.RATE_LIMIT_ENABLED = 'false';
    process.env.RATE_LIMIT_POINTS = '12';
    process.env.RATE_LIMIT_DURATION_SEC = '30';
    process.env.RATE_LIMIT_HEADER_PREFIX = 'Quota';

    expect(httpConfig().rateLimit).toEqual({
      enabled: false,
      points: 12,
      durationSec: 30,
      headerPrefix: 'Quota',
      redisFailurePolicy: 'open',
    });
  });
});
