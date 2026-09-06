import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import agentsConfig from '../../../../src/infrastructure/config/agents.config';

const KEYS = [
  'AGENT_RUN_RECONCILE_INTERVAL_MS',
  'AGENT_RUN_RECONCILE_STALE_AFTER_MS',
  'AGENT_RUN_RECONCILE_BATCH_SIZE',
];

describe('agentsConfig', () => {
  const original = process.env;

  beforeEach(() => {
    process.env = { ...original };
    for (const key of KEYS) delete process.env[key];
  });

  afterEach(() => {
    process.env = original;
  });

  it('boots with no agent variables set at all', () => {
    expect(agentsConfig()).toEqual({
      reconcile: {
        intervalMs: 60_000,
        staleAfterMs: 120_000,
        batchSize: 50,
      },
    });
  });

  it('reads and coerces every reconciler knob from the environment', () => {
    process.env.AGENT_RUN_RECONCILE_INTERVAL_MS = '5000';
    process.env.AGENT_RUN_RECONCILE_STALE_AFTER_MS = '30000';
    process.env.AGENT_RUN_RECONCILE_BATCH_SIZE = '10';

    expect(agentsConfig().reconcile).toEqual({
      intervalMs: 5_000,
      staleAfterMs: 30_000,
      batchSize: 10,
    });
  });

  it('produces numbers, not the strings the environment supplied', () => {
    process.env.AGENT_RUN_RECONCILE_INTERVAL_MS = '5000';
    process.env.AGENT_RUN_RECONCILE_STALE_AFTER_MS = '30000';
    process.env.AGENT_RUN_RECONCILE_BATCH_SIZE = '10';

    for (const value of Object.values(agentsConfig().reconcile)) {
      expect(typeof value).toBe('number');
    }
  });

  it('exposes exactly the three reconciler knobs', () => {
    expect(Object.keys(agentsConfig().reconcile)).toEqual([
      'intervalMs',
      'staleAfterMs',
      'batchSize',
    ]);
  });

  describe('fail-fast', () => {
    it('rejects a sweep interval below the floor', () => {
      process.env.AGENT_RUN_RECONCILE_INTERVAL_MS = '100';

      expect(() => agentsConfig()).toThrow();
    });

    it('rejects a sweep interval so long the loop stops being a recovery', () => {
      process.env.AGENT_RUN_RECONCILE_INTERVAL_MS = '600001';

      expect(() => agentsConfig()).toThrow();
    });

    it('rejects a staleness threshold below the floor', () => {
      process.env.AGENT_RUN_RECONCILE_STALE_AFTER_MS = '999';

      expect(() => agentsConfig()).toThrow();
    });

    it('rejects a staleness threshold beyond an hour', () => {
      process.env.AGENT_RUN_RECONCILE_STALE_AFTER_MS = '3600001';

      expect(() => agentsConfig()).toThrow();
    });

    it('rejects a zero batch size, which would examine nothing forever', () => {
      process.env.AGENT_RUN_RECONCILE_BATCH_SIZE = '0';

      expect(() => agentsConfig()).toThrow();
    });

    it('rejects a batch size large enough to be a Redis incident per pass', () => {
      process.env.AGENT_RUN_RECONCILE_BATCH_SIZE = '501';

      expect(() => agentsConfig()).toThrow();
    });

    it('rejects a fractional batch size rather than truncating it', () => {
      process.env.AGENT_RUN_RECONCILE_BATCH_SIZE = '2.5';

      expect(() => agentsConfig()).toThrow();
    });

    it('rejects a non-numeric value rather than coercing it to NaN', () => {
      process.env.AGENT_RUN_RECONCILE_INTERVAL_MS = 'never';

      expect(() => agentsConfig()).toThrow();
    });
  });
});
