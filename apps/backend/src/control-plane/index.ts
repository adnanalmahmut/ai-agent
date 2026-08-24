/**
 * Public surface of the control plane.
 *
 * Features depend on `RuntimeConfigResolver`. The three services are exported
 * because the operator controller and the tests need them, not as an invitation
 * to inject them individually — see the resolver's own note on why a feature
 * taking all three at once is the point.
 */
export {
  ControlPlaneCoreModule,
  ControlPlaneModule,
} from './control-plane.module';
export { RuntimeConfigResolver } from './runtime-config.resolver';

export {
  AUDIT_PAGE_SIZE,
  CONTROL_PLANE_AUDIT_ACTIONS,
  CONTROL_PLANE_AUDIT_RESOURCES,
  ControlPlaneAuditService,
  MAX_AUDIT_PAGE_SIZE,
} from './audit/control-plane-audit.service';
export type {
  ControlPlaneAuditAction,
  ControlPlaneAuditEntry,
  ControlPlaneAuditResource,
  ControlPlaneAuditState,
} from './audit/control-plane-audit.service';

export { FeatureFlagService } from './feature-flags/feature-flag.service';
export type {
  FeatureFlagSource,
  FeatureFlagState,
} from './feature-flags/feature-flag.service';
export {
  FEATURE_FLAGS,
  FEATURE_FLAG_KEYS,
  isFeatureFlagKey,
} from './feature-flags/feature-flag.registry';
export type { FeatureFlagKey } from './feature-flags/feature-flag.registry';

export { RuntimeSettingService } from './runtime-settings/runtime-setting.service';
export type { RuntimeSettingState } from './runtime-settings/runtime-setting.service';
export {
  RUNTIME_SETTINGS,
  RUNTIME_SETTING_KEYS,
  isRuntimeSettingKey,
} from './runtime-settings/runtime-setting.registry';
export type {
  RuntimeSettingKey,
  RuntimeSettingValue,
} from './runtime-settings/runtime-setting.registry';

export { ManagedSecretService } from './managed-secrets/managed-secret.service';
export type { ManagedSecretDescription } from './managed-secrets/managed-secret.service';
export {
  MANAGED_SECRETS,
  MANAGED_SECRET_KEYS,
  isManagedSecretKey,
} from './managed-secrets/managed-secret.registry';
export type { ManagedSecretKey } from './managed-secrets/managed-secret.registry';
/**
 * The cipher primitives are deliberately absent.
 *
 * `sealSecret` and `openSecret` take a key as an argument, so exporting them
 * here would let any feature encrypt or decrypt a credential with a key of its
 * choosing — bypassing the fingerprint check, the `SECRET_UNREADABLE` contract
 * and the warn-log that `ManagedSecretService` exists to centralise. The
 * service is the module's credential surface; the cipher is its internals, and
 * the one place that reaches past it is a spec importing the file directly.
 */
