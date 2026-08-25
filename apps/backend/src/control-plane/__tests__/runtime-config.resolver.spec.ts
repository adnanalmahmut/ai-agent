import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { AppException } from '../../core/errors';
import type { FeatureFlagKey } from '../feature-flags/feature-flag.registry';
import type { FeatureFlagService } from '../feature-flags/feature-flag.service';
import type { ManagedSecretKey } from '../managed-secrets/managed-secret.registry';
import type { ManagedSecretService } from '../managed-secrets/managed-secret.service';
import type { RuntimeSettingKey } from '../runtime-settings/runtime-setting.registry';
import type { RuntimeSettingService } from '../runtime-settings/runtime-setting.service';
import { RuntimeConfigResolver } from '../runtime-config.resolver';

/**
 * Three delegating methods, and the reason they are worth a spec.
 *
 * Every rule this class touches is enforced somewhere else, so there is a
 * temptation to treat it as too thin to test. That is exactly backwards: it is
 * the single dependency a feature injects in order to gate work, which makes it
 * the one place where a gate can be lost *silently*. An `assertFeature` that
 * returned a resolved promise without consulting anything satisfies the
 * signature, compiles, and turns every feature flag in the application off as a
 * safety mechanism while leaving all of them reading as on. Nothing downstream
 * would notice, because a gate that never refuses looks identical to a gate
 * whose flag is enabled.
 *
 * So what is asserted here is not "does it forward" but the two consequences of
 * forwarding: a refusal reaches the caller, and the scope it was given is the
 * scope that was evaluated.
 */

/** Real registry members, because the resolver forwards keys rather than judging them. */
const FLAG: FeatureFlagKey = 'agents.enabled';
const SETTING: RuntimeSettingKey =
  'agents.max_concurrent_runs_per_organization';
const SECRET: ManagedSecretKey = 'openai.api_key';

const ORGANIZATION_ID = 'org-resolver-1';

/** Obviously fake, and never a real credential. */
const CANARY = 'sk-CANARY-do-not-log-0000000000';

describe('RuntimeConfigResolver', () => {
  const assertEnabled =
    jest.fn<(key: unknown, scope: unknown) => Promise<void>>();
  const isEnabled =
    jest.fn<(key: unknown, scope: unknown) => Promise<boolean>>();
  const getSetting = jest.fn<(key: unknown) => Promise<unknown>>();
  const reveal = jest.fn<(key: unknown) => Promise<string>>();

  const flags = { assertEnabled, isEnabled } as unknown as FeatureFlagService;
  const settings = { get: getSetting } as unknown as RuntimeSettingService;
  const secrets = { reveal } as unknown as ManagedSecretService;

  let resolver: RuntimeConfigResolver;

  beforeEach(() => {
    assertEnabled.mockReset().mockResolvedValue(undefined);
    isEnabled.mockReset().mockResolvedValue(true);
    getSetting.mockReset().mockResolvedValue(10);
    reveal.mockReset().mockResolvedValue(CANARY);

    resolver = new RuntimeConfigResolver(flags, settings, secrets);
  });

  describe('assertFeature', () => {
    /**
     * The assertion that a no-op gate cannot pass. A resolver that skipped the
     * flag service entirely would resolve here, and every caller that trusted
     * this method to refuse would accept work the platform had switched off.
     */
    it('refuses when the flag service refuses', async () => {
      const refusal = new AppException('FEATURE_DISABLED', {
        context: { featureFlag: FLAG },
      });
      assertEnabled.mockRejectedValue(refusal);

      await expect(resolver.assertFeature(FLAG)).rejects.toBe(refusal);
    });

    it('passes silently when the flag service allows the work', async () => {
      await expect(resolver.assertFeature(FLAG)).resolves.toBeUndefined();
      expect(assertEnabled).toHaveBeenCalledTimes(1);
    });

    /**
     * A gate that dropped the scope would evaluate the platform value for an
     * organization that had opted out — the flag would read as enabled and the
     * tenant's refusal would never be applied.
     */
    it('evaluates the scope it was given rather than the platform value', async () => {
      await resolver.assertFeature(FLAG, { organizationId: ORGANIZATION_ID });

      expect(assertEnabled).toHaveBeenCalledWith(FLAG, {
        organizationId: ORGANIZATION_ID,
      });
    });
  });

  describe('isFeatureEnabled', () => {
    it.each([true, false])(
      'reports the flag service answer of %s',
      async (answer) => {
        isEnabled.mockResolvedValue(answer);

        await expect(
          resolver.isFeatureEnabled(FLAG, { organizationId: ORGANIZATION_ID }),
        ).resolves.toBe(answer);
        expect(isEnabled).toHaveBeenCalledWith(FLAG, {
          organizationId: ORGANIZATION_ID,
        });
      },
    );
  });

  it('returns the setting the registry-backed service resolved', async () => {
    getSetting.mockResolvedValue(25);

    await expect(resolver.setting(SETTING)).resolves.toBe(25);
    expect(getSetting).toHaveBeenCalledWith(SETTING);
  });

  describe('secret', () => {
    it('hands back the plaintext the secret service revealed', async () => {
      await expect(resolver.secret(SECRET)).resolves.toBe(CANARY);
      expect(reveal).toHaveBeenCalledWith(SECRET);
    });

    it('propagates an unreadable credential instead of returning nothing', async () => {
      const failure = new AppException('SECRET_UNREADABLE', {
        context: { secretKey: SECRET },
      });
      reveal.mockRejectedValue(failure);

      await expect(resolver.secret(SECRET)).rejects.toBe(failure);
    });
  });

  /**
   * The resolver holds nothing, and that is a behaviour rather than a
   * description.
   *
   * A cache added here would be invisible to every other spec in the control
   * plane and would undo the two properties those specs exist to protect: a
   * disabled flag stops accepting work immediately, and a rotated credential is
   * used on the very next call rather than after a TTL.
   */
  it('resolves afresh on every call rather than caching an answer', async () => {
    await resolver.isFeatureEnabled(FLAG);
    await resolver.isFeatureEnabled(FLAG);
    await resolver.setting(SETTING);
    await resolver.setting(SETTING);
    await resolver.secret(SECRET);
    await resolver.secret(SECRET);

    expect(isEnabled).toHaveBeenCalledTimes(2);
    expect(getSetting).toHaveBeenCalledTimes(2);
    expect(reveal).toHaveBeenCalledTimes(2);
  });

  /**
   * A credential must not become ambient. Copying one into the environment is
   * the mistake that turns a scoped secret into something every child process
   * and every crash dump inherits, and the resolver is the last place it passes
   * through before an adapter uses it.
   */
  it('does not copy a revealed credential into the environment', async () => {
    await resolver.secret(SECRET);

    expect(JSON.stringify(process.env)).not.toContain('CANARY');
  });
});
