import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import redisConfig from '../../../../src/infrastructure/config/redis.config';

describe('redisConfig', () => {
  const original = process.env;

  beforeEach(() => {
    process.env = { ...original };
    for (const key of [
      'REDIS_URL',
      'REDIS_KEY_PREFIX',
      'REDIS_CONNECT_TIMEOUT_MS',
      'REDIS_COMMAND_TIMEOUT_MS',
      'REDIS_MAX_RETRIES_PER_REQUEST',
    ]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = original;
  });

  it('applies bounded defaults around the connection URL', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';

    expect(redisConfig()).toEqual({
      url: 'redis://localhost:6379',
      keyPrefix: 'app:',
      connectTimeoutMs: 5_000,
      commandTimeoutMs: 2_000,
      maxRetriesPerRequest: 2,
    });
  });

  it('accepts a TLS URL with credentials and a database index', () => {
    process.env.REDIS_URL = 'rediss://user:secret@redis.example.com:6380/3';

    expect(redisConfig().url).toBe(
      'rediss://user:secret@redis.example.com:6380/3',
    );
  });

  it('appends the namespace separator exactly once', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.REDIS_KEY_PREFIX = 'agents';

    expect(redisConfig().keyPrefix).toBe('agents:');
  });

  it('reads explicit timeouts and the retry budget', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.REDIS_CONNECT_TIMEOUT_MS = '1500';
    process.env.REDIS_COMMAND_TIMEOUT_MS = '750';
    process.env.REDIS_MAX_RETRIES_PER_REQUEST = '1';

    expect(redisConfig()).toMatchObject({
      connectTimeoutMs: 1_500,
      commandTimeoutMs: 750,
      maxRetriesPerRequest: 1,
    });
  });

  describe('fail-fast', () => {
    it('refuses to boot without a URL', () => {
      expect(() => redisConfig()).toThrow();
    });

    it('rejects a URL that is not a Redis URL', () => {
      process.env.REDIS_URL = 'http://localhost:6379';

      expect(() => redisConfig()).toThrow(/redis:\/\/ or rediss:\/\//);
    });

    it('rejects a bare host and port', () => {
      process.env.REDIS_URL = 'localhost:6379';

      expect(() => redisConfig()).toThrow();
    });

    it('rejects a key prefix containing pattern characters', () => {
      process.env.REDIS_URL = 'redis://localhost:6379';
      process.env.REDIS_KEY_PREFIX = 'app*{shard}';

      expect(() => redisConfig()).toThrow(/REDIS_KEY_PREFIX/);
    });

    it('rejects an empty key prefix rather than silently using none', () => {
      process.env.REDIS_URL = 'redis://localhost:6379';
      process.env.REDIS_KEY_PREFIX = '';

      expect(() => redisConfig()).toThrow(/REDIS_KEY_PREFIX/);
    });

    it('refuses a retry budget above the fast-fail ceiling', () => {
      process.env.REDIS_URL = 'redis://localhost:6379';
      process.env.REDIS_MAX_RETRIES_PER_REQUEST = '50';

      expect(() => redisConfig()).toThrow();
    });

    it('refuses to disable per-request retries entirely', () => {
      process.env.REDIS_URL = 'redis://localhost:6379';
      process.env.REDIS_MAX_RETRIES_PER_REQUEST = '0';

      expect(() => redisConfig()).toThrow();
    });

    it('refuses an unbounded command timeout', () => {
      process.env.REDIS_URL = 'redis://localhost:6379';
      process.env.REDIS_COMMAND_TIMEOUT_MS = '600000';

      expect(() => redisConfig()).toThrow();
    });
  });
});
