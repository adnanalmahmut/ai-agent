import { describe, expect, it } from '@jest/globals';

import {
  FEATURE_FLAGS,
  FEATURE_FLAG_KEYS,
} from '../../../../src/features/control-plane/feature-flags/feature-flag.registry';

/**
 * The defaults, asserted as a whole rather than sampled.
 *
 * A default is the value every organization gets until an operator decides
 * otherwise, so flipping one is a fleet-wide change made by editing a single
 * word. Every flag in this catalog gates something that either costs money per
 * invocation or accepts work into a queue, and none of them has an owner
 * waiting to turn it on — which is what makes off the correct default and a
 * silent flip to `true` the failure worth catching.
 *
 * Asserted totally, so a new flag has to appear here. If one ever legitimately
 * defaults on, add it as a named exception with the reason: that is a decision
 * that should cost somebody a sentence.
 */
describe('the feature flag catalog', () => {
  it('is not empty', () => {
    expect(FEATURE_FLAG_KEYS.length).toBeGreaterThan(0);
  });

  it('defaults every flag off', () => {
    const enabledByDefault = FEATURE_FLAG_KEYS.filter(
      (key) => FEATURE_FLAGS[key].defaultEnabled,
    );

    expect(enabledByDefault).toEqual([]);
  });

  /**
   * Both agent flags have to be organization-overridable, because the pattern
   * they serve is a per-organization rollout of a billed feature. A flag that
   * quietly stopped being overridable would leave the Platform's per-org
   * control writing rows nothing reads.
   */
  it('keeps the agent flags rollable per organization', () => {
    for (const key of ['agents.enabled', 'content_ideas.enabled'] as const) {
      expect(FEATURE_FLAGS[key].organizationOverridable).toBe(true);
    }
  });
});
