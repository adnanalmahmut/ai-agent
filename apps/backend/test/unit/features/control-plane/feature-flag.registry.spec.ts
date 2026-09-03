import { describe, expect, it } from '@jest/globals';

import {
  FEATURE_FLAGS,
  FEATURE_FLAG_KEYS,
} from '../../../../src/features/control-plane/feature-flags/feature-flag.registry';

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

  it('keeps the agent flags rollable per organization', () => {
    for (const key of ['agents.enabled', 'content_ideas.enabled'] as const) {
      expect(FEATURE_FLAGS[key].organizationOverridable).toBe(true);
    }
  });
});
