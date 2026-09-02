import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import redisConfig from '../redis.config';

/**
 * The factory reads `process.env` when `ConfigModule` calls it during boot, so
 * "does this throw" is the same question as "does the process start".
 */
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
    /**
     * Deliberately has no localhost default. A default would let a worker boot
     * against nothing and retry connections forever while queued work piled up
     * in the outbox — a failure that looks like a slow system rather than a
     * misconfigured one.
     */
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

    /**
     * The prefix is concatenated into key names. Characters that Redis treats
     * specially in patterns — or a stray `{}` hash tag under Cluster — would
     * change which keyspace is addressed rather than merely look untidy.
     */
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

    /**
     * The cap is the point of the variable. An unbounded retry budget on a
     * request-path connection converts a Redis outage into hung HTTP requests,
     * and on the outbox dispatcher it prevents control from ever returning so
     * the event can be left for the next pass. The worker's mandatory `null`
     * lives in the connection layer, where an environment variable cannot
     * reach it.
     */
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
