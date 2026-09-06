import { z } from 'zod';

import { isoDateTimeToDate } from '../../infrastructure/http';
import { FEATURE_FLAG_KEYS } from './feature-flags/feature-flag.registry';
import { MANAGED_SECRET_KEYS } from './managed-secrets/managed-secret.registry';
import { RUNTIME_SETTING_KEYS } from './runtime-settings/runtime-setting.registry';

/**
 * The Control Plane API payload contract. These schemas are the single
 * authored definition of what the endpoints send and accept: the services take
 * their return types from `z.output`, and the OpenAPI document takes its
 * schemas from `z.input`, so Platform reads the generated form of the same
 * definition rather than a second description of it.
 *
 * Nothing here validates a response at runtime. It defines the contract and
 * types it; the interceptor still serializes whatever a handler returns.
 *
 * This describes what an operator may read and set. It is not the
 * authorization: `@UserHasPermission` on each route owns that, and nothing
 * here changes who may call anything.
 */

/*
 * Every key comes from its registry, so the documented vocabularies cannot
 * name a slot the platform does not have.
 */
const featureFlagKey = z.enum(FEATURE_FLAG_KEYS);
const runtimeSettingKey = z.enum(RUNTIME_SETTING_KEYS);
const managedSecretKey = z.enum(MANAGED_SECRET_KEYS);

/** Where a flag's effective value came from. */
export const FEATURE_FLAG_SOURCES = [
  'organization',
  'platform',
  'default',
] as const;

export const featureFlagStateSchema = z.object({
  key: featureFlagKey,
  description: z.string(),
  enabled: z.boolean(),
  source: z.enum(FEATURE_FLAG_SOURCES),
  defaultEnabled: z.boolean(),
  // An override that was never set is absent from the body rather than null:
  // JSON serialization drops an undefined value, and "not overridden" is what
  // that absence means.
  platformOverride: z.boolean().optional(),
  organizationOverride: z.boolean().optional(),
  organizationOverridable: z.boolean(),
});

export const featureFlagOverrideSchema = z
  .object({ enabled: z.boolean() })
  .strict();

export const runtimeSettingStateSchema = z.object({
  key: runtimeSettingKey,
  description: z.string(),
  // A setting's value is whatever its registered schema accepts, so the
  // contract describes the envelope around it rather than the value itself.
  value: z.unknown(),
  isDefault: z.boolean(),
  storedValueRejected: z.boolean(),
  defaultValue: z.unknown(),
  sensitivity: z.enum(['public', 'internal']),
  editable: z.boolean(),
  updatedAt: isoDateTimeToDate.optional(),
});

export const runtimeSettingValueSchema = z
  .object({ value: z.unknown() })
  .strict();

/**
 * What an operator may learn about a stored credential.
 *
 * A managed secret is write-only. This schema is the whole of what the API
 * answers with, and it carries no plaintext, no decrypted value, no
 * ciphertext, and no key material — only whether a slot is filled and whether
 * the value in it can still be used. The administration contract test under
 * `apps/control-plane/test/unit/infrastructure/docs/` holds that closed.
 */
export const managedSecretDescriptionSchema = z.object({
  key: managedSecretKey,
  description: z.string(),
  configured: z.boolean(),
  label: z.string().optional(),
  algorithm: z.string().optional(),
  keyVersion: z.string().optional(),
  lastRotatedAt: isoDateTimeToDate.optional(),
  updatedAt: isoDateTimeToDate.optional(),
  // False where a slot is filled but the stored value can no longer be read
  // with the keys this deployment holds.
  usable: z.boolean(),
});

/** The credential itself, which crosses only in this direction. */
export const managedSecretInputSchema = z
  .object({
    value: z.string().min(1),
    label: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

/** The families a change can be recorded against, and filtered by. */
export const CONTROL_PLANE_AUDIT_RESOURCES = [
  'featureFlag',
  'runtimeSetting',
  'managedSecret',
] as const;

export type ControlPlaneAuditResource =
  (typeof CONTROL_PLANE_AUDIT_RESOURCES)[number];

export const controlPlaneAuditEntrySchema = z.object({
  id: z.string(),
  occurredAt: isoDateTimeToDate,
  actorUserId: z.string().nullable(),
  /*
   * A stored row, not a closed vocabulary. An event written by an earlier
   * version carries whatever that version called it, so a reader has to cope
   * with a name it does not know — which the audit screen already does.
   * Documenting these as enums would make that branch unreachable by type and
   * describe the history as narrower than it is.
   */
  resource: z.string(),
  action: z.string(),
  resourceKey: z.string(),
  organizationId: z.string().nullable(),
  before: z.unknown(),
  after: z.unknown(),
});

/**
 * Cursor pagination, which is not the envelope's `page`/`perPage` metadata:
 * the interceptor only lifts pagination out of a payload that carries a
 * `pagination` key, so this whole object is the response `data`.
 */
export const controlPlaneAuditPageSchema = z.object({
  items: z.array(controlPlaneAuditEntrySchema),
  nextCursor: z.string().nullable(),
});

export const controlPlaneAuditQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(512).optional(),
    limit: z.coerce.number().int().optional(),
    resource: z.enum(CONTROL_PLANE_AUDIT_RESOURCES).optional(),
    resourceKey: z.string().trim().min(1).max(120).optional(),
    organizationId: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
