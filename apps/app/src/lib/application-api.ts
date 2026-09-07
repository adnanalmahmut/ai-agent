import {
  ApiError,
  ApiUnavailableError,
  errorDetailLines,
  NO_ERROR_DETAILS,
  type ApiErrorDetails,
  type ApiFieldError,
} from '@repo/api-client';
import { createBrowserTransport } from '@repo/api-client/browser';
import type { operations } from '@repo/api-client/generated';

import { API_BASE_PATH, CONTROL_PLANE_PATH } from '@/config/paths';
import { everyValueOf } from '@/lib/api/vocabulary';

/**
 * The application's API surface. The transport, the wire protocol and the two
 * error types come from `@repo/api-client`; what is written here is which
 * endpoints this application calls and what it sends them.
 *
 * The shared pieces are re-exported so that a screen keeps importing one
 * module rather than two, and so that moving them out was not a rename for
 * every caller.
 */
export type { ApiErrorDetails, ApiFieldError };
export { ApiError, ApiUnavailableError, errorDetailLines, NO_ERROR_DETAILS };

export const apiRequest = createBrowserTransport({
  basePath: API_BASE_PATH,
});

/* ---------------------------------------------------------------------------
 * Platform administration
 *
 * The Backend's Zod contract is the authored definition of these payloads.
 * They arrive here as generated OpenAPI types, so everything below is an alias
 * of that contract rather than a second description of it: change a schema,
 * run `pnpm api:types`, and the difference surfaces as a type error at
 * whichever caller it actually breaks.
 * ------------------------------------------------------------------------- */

type Data<O extends keyof operations, S extends number> = operations[O] extends {
  responses: Record<S, { content: { 'application/json': { data: infer D } } }>;
}
  ? D
  : never;

export type FeatureFlagState = Data<'listFeatureFlags', 200>[number];

export type FeatureFlagSource = FeatureFlagState['source'];

export type RuntimeSettingState = Data<'listRuntimeSettings', 200>[number];

/**
 * What an operator may learn about a stored credential.
 *
 * A managed secret is write-only, and this alias is the whole of what the API
 * answers with: no plaintext, no decrypted value, no ciphertext, no key
 * material. Reading one would not compile, which is the point of taking the
 * type from the contract instead of restating it.
 */
export type ManagedSecretDescription = Data<'listManagedSecrets', 200>[number];

export type ControlPlaneAuditPage = Data<'listControlPlaneAudit', 200>;

export type ControlPlaneAuditEntry = ControlPlaneAuditPage['items'][number];

/**
 * The vocabularies as runtime values, which the types alone cannot provide.
 *
 * `source` is a wire enum, so `everyValueOf` holds that list level with it in
 * both directions. The audit actions are not a wire enum: an event written by an earlier version carries whatever that
 * version called it, so the contract documents `action` as a string and the
 * screen already falls back to an "unknown action" label. This list is the set
 * this release can translate, not a claim about what the history contains.
 */
export const FEATURE_FLAG_SOURCES = everyValueOf<FeatureFlagSource>()([
  'organization',
  'platform',
  'default',
]);

export const CONTROL_PLANE_AUDIT_ACTIONS = [
  'featureFlag.setPlatformOverride',
  'featureFlag.clearPlatformOverride',
  'featureFlag.setOrganizationOverride',
  'featureFlag.clearOrganizationOverride',
  'runtimeSetting.set',
  'runtimeSetting.reset',
  'managedSecret.configure',
  'managedSecret.rotate',
  'managedSecret.remove',
  'managedSecret.reencrypt',
] as const;

export type ControlPlaneAuditAction =
  (typeof CONTROL_PLANE_AUDIT_ACTIONS)[number];

const key = (value: string) => encodeURIComponent(value);

export async function listFeatureFlags(
  signal?: AbortSignal,
): Promise<FeatureFlagState[]> {
  return apiRequest(`${CONTROL_PLANE_PATH}/feature-flags`, { signal });
}

export async function setFeatureFlag(
  flagKey: string,
  enabled: boolean,
): Promise<FeatureFlagState> {
  return apiRequest(`${CONTROL_PLANE_PATH}/feature-flags/${key(flagKey)}`, {
    method: 'PUT',
    body: { enabled },
  });
}

export async function clearFeatureFlag(
  flagKey: string,
): Promise<FeatureFlagState> {
  return apiRequest(`${CONTROL_PLANE_PATH}/feature-flags/${key(flagKey)}`, {
    method: 'DELETE',
  });
}

export async function listRuntimeSettings(
  signal?: AbortSignal,
): Promise<RuntimeSettingState[]> {
  return apiRequest(`${CONTROL_PLANE_PATH}/settings`, { signal });
}

export async function setRuntimeSetting(
  settingKey: string,
  value: unknown,
): Promise<RuntimeSettingState> {
  return apiRequest(`${CONTROL_PLANE_PATH}/settings/${key(settingKey)}`, {
    method: 'PUT',
    body: { value },
  });
}

export async function resetRuntimeSetting(
  settingKey: string,
): Promise<RuntimeSettingState> {
  return apiRequest(`${CONTROL_PLANE_PATH}/settings/${key(settingKey)}`, {
    method: 'DELETE',
  });
}

export async function listManagedSecrets(
  signal?: AbortSignal,
): Promise<ManagedSecretDescription[]> {
  return apiRequest(`${CONTROL_PLANE_PATH}/secrets`, { signal });
}

export async function setManagedSecret(
  secretKey: string,
  value: string,
  label?: string,
): Promise<ManagedSecretDescription> {
  return apiRequest(`${CONTROL_PLANE_PATH}/secrets/${key(secretKey)}`, {
    method: 'PUT',
    body: label === undefined ? { value } : { value, label },
  });
}

export async function removeManagedSecret(
  secretKey: string,
): Promise<ManagedSecretDescription> {
  return apiRequest(`${CONTROL_PLANE_PATH}/secrets/${key(secretKey)}`, {
    method: 'DELETE',
  });
}

export function listControlPlaneAudit(
  options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<ControlPlaneAuditPage> {
  const query = new URLSearchParams();

  if (options.cursor !== undefined) query.set('cursor', options.cursor);
  if (options.limit !== undefined) query.set('limit', String(options.limit));

  const suffix = query.size === 0 ? '' : `?${query.toString()}`;

  return apiRequest(`${CONTROL_PLANE_PATH}/audit${suffix}`, {
    signal: options.signal,
  });
}

/* ---------------------------------------------------------------------------
 * Account administration
 *
 * A deactivation is reversible and says what it did — which account, whether
 * it is now deleted, and how many sessions it ended. These functions used to
 * throw that away; the contract describes it, so they answer with it.
 * ------------------------------------------------------------------------- */

// All three are a POST with no `@HttpCode`, so the API answers 201.
export type AccountLifecycleResult = Data<'deactivateUserAccount', 201>;

/** The optional reason a deactivation may be given, as the contract has it. */
export type AccountDeactivationReason = NonNullable<
  operations['deactivateUserAccount']['requestBody']
>['content']['application/json'];

export function deactivateUserAccount(
  userId: string,
  reason?: string,
): Promise<AccountLifecycleResult> {
  return apiRequest(`/admin/users/${encodeURIComponent(userId)}/deactivate`, {
    method: 'POST',
    // An absent reason sends no body, which is what the endpoint already saw.
    body:
      reason === undefined
        ? undefined
        : ({ reason } satisfies AccountDeactivationReason),
  });
}

export function restoreUserAccount(
  userId: string,
): Promise<AccountLifecycleResult> {
  return apiRequest(`/admin/users/${encodeURIComponent(userId)}/restore`, {
    method: 'POST',
  });
}

export function deactivateSelfAccount(
  reason?: string,
): Promise<AccountLifecycleResult> {
  return apiRequest('/user/account/deactivate', {
    method: 'POST',
    body:
      reason === undefined
        ? undefined
        : ({ reason } satisfies AccountDeactivationReason),
  });
}
