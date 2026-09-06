import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { AppException } from '../../../../src/core/errors';
import type { FeatureFlagKey } from '../../../../src/features/control-plane/feature-flags/feature-flag.registry';
import type { FeatureFlagService } from '../../../../src/features/control-plane/feature-flags/feature-flag.service';
import type { ManagedSecretKey } from '../../../../src/features/control-plane/managed-secrets/managed-secret.registry';
import type { ManagedSecretService } from '../../../../src/features/control-plane/managed-secrets/managed-secret.service';
import type { RuntimeSettingKey } from '../../../../src/features/control-plane/runtime-settings/runtime-setting.registry';
import type { RuntimeSettingService } from '../../../../src/features/control-plane/runtime-settings/runtime-setting.service';
import { RuntimeConfigResolver } from '../../../../src/features/control-plane/runtime-config.resolver';

const FLAG: FeatureFlagKey = 'agents.enabled';
const SETTING: RuntimeSettingKey =
  'agents.max_concurrent_runs_per_organization';
const SECRET: ManagedSecretKey = 'openai.api_key';

const ORGANIZATION_ID = 'org-resolver-1';

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

  it('does not copy a revealed credential into the environment', async () => {
    await resolver.secret(SECRET);

    expect(JSON.stringify(process.env)).not.toContain('CANARY');
  });
});
