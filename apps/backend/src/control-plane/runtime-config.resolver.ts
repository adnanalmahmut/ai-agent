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

/**
 * The one dependency a feature needs in order to ask the control plane
 * anything.
 *
 * Its value is not abstraction — it is three delegating methods — but
 * *dependency shape*. A feature that injected the three services separately
 * would be free to inject only two, and the one it left out is invariably the
 * flag check. Requiring this instead makes "did you gate this?" answerable by
 * looking at one constructor.
 *
 * It is deliberately not a god object with its own state, cache, or policy. It
 * holds nothing, decides nothing, and every rule lives in the service it
 * forwards to. If it ever grows a behaviour of its own, that behaviour belongs
 * in one of the three.
 */
@Injectable()
export class RuntimeConfigResolver {
  constructor(
    private readonly flags: FeatureFlagService,
    private readonly settings: RuntimeSettingService,
    private readonly secrets: ManagedSecretService,
  ) {}

  /** Refuses unless the feature is on. The standard gate for accepting work. */
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

  /**
   * The plaintext of a provider credential, for immediate use.
   *
   * Callers must pass it straight to the adapter that needs it. It must not be
   * stored on a field, written to a log, or copied into `process.env` — the
   * last of which would make a scoped credential ambient for every child
   * process and every crash dump.
   */
  secret(key: ManagedSecretKey): Promise<string> {
    return this.secrets.reveal(key);
  }
}
