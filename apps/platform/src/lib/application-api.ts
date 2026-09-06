import {
  ApiError,
  ApiUnavailableError,
  errorDetailLines,
  NO_ERROR_DETAILS,
  type ApiErrorDetails,
  type ApiFieldError,
} from '@repo/api-client';
import { createBrowserTransport } from '@repo/api-client/browser';

import { API_BASE_PATH, CONTROL_PLANE_PATH } from '@/config/paths';

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

export const FEATURE_FLAG_SOURCES = [
  'organization',
  'platform',
  'default',
] as const;

export type FeatureFlagSource = (typeof FEATURE_FLAG_SOURCES)[number];

export type FeatureFlagState = {
  key: string;
  description: string;
  enabled: boolean;
  source: FeatureFlagSource;
  defaultEnabled: boolean;
  platformOverride: boolean | undefined;
  organizationOverride: boolean | undefined;
  organizationOverridable: boolean;
};

export type RuntimeSettingState = {
  key: string;
  description: string;
  value: unknown;
  isDefault: boolean;
  storedValueRejected: boolean;
  defaultValue: unknown;
  sensitivity: string;
  editable: boolean;
  updatedAt: string | undefined;
};

export type ManagedSecretDescription = {
  key: string;
  description: string;
  configured: boolean;
  label: string | undefined;
  algorithm: string | undefined;
  keyVersion: string | undefined;
  lastRotatedAt: string | undefined;
  updatedAt: string | undefined;
  usable: boolean;
};

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

export type ControlPlaneAuditEntry = {
  id: string;
  occurredAt: string;
  actorUserId: string | null;
  resource: 'featureFlag' | 'runtimeSetting' | 'managedSecret';
  action: ControlPlaneAuditAction;
  resourceKey: string;
  organizationId: string | null;
  before: unknown;
  after: unknown;
};

export type ControlPlaneAuditPage = {
  items: ControlPlaneAuditEntry[];
  nextCursor: string | null;
};

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

export async function deactivateUserAccount(userId: string): Promise<void> {
  await apiRequest(`/admin/users/${encodeURIComponent(userId)}/deactivate`, {
    method: 'POST',
  });
}

export async function restoreUserAccount(userId: string): Promise<void> {
  await apiRequest(`/admin/users/${encodeURIComponent(userId)}/restore`, {
    method: 'POST',
  });
}

export async function deactivateSelfAccount(): Promise<void> {
  await apiRequest('/user/account/deactivate', {
    method: 'POST',
  });
}
