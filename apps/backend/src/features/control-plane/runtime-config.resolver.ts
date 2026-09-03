import { Injectable } from '@nestjs/common';

import { FeatureFlagService } from './feature-flags/feature-flag.service';
import type { FeatureFlagKey } from './feature-flags/feature-flag.registry';
import { ManagedSecretService } from './managed-secrets/managed-secret.service';
import type { ManagedSecretKey } from './managed-secrets/managed-secret.registry';
import { RuntimeSettingService } from './runtime-settings/runtime-setting.service';
import type {
  RuntimeSettingKey,
  RuntimeSettingValue,
} from './runtime-settings/runtime-setting.registry';

@Injectable()
export class RuntimeConfigResolver {
  constructor(
    private readonly flags: FeatureFlagService,
    private readonly settings: RuntimeSettingService,
    private readonly secrets: ManagedSecretService,
  ) {}

  assertFeature(
    key: FeatureFlagKey,
    scope: { organizationId?: string } = {},
  ): Promise<void> {
    return this.flags.assertEnabled(key, scope);
  }

  isFeatureEnabled(
    key: FeatureFlagKey,
    scope: { organizationId?: string } = {},
  ): Promise<boolean> {
    return this.flags.isEnabled(key, scope);
  }

  setting<K extends RuntimeSettingKey>(
    key: K,
  ): Promise<RuntimeSettingValue<K>> {
    return this.settings.get(key);
  }

  secret(key: ManagedSecretKey): Promise<string> {
    return this.secrets.reveal(key);
  }
}
