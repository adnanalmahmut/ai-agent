import { API_BASE_PATH, CONTROL_PLANE_PATH } from '@/config/paths';

export class ApiUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('The platform API could not be reached');
    this.name = 'ApiUnavailableError';
    this.cause = cause;
  }
}

export type ApiErrorDetails = {
  issues?: string[];
  reason?: string;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly details: ApiErrorDetails = {},
  ) {
    super(`Platform API responded with ${status}`);
    this.name = 'ApiError';
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = 'GET', body, signal, headers } = options;

  let response: Response;

  try {
    response = await fetch(`${API_BASE_PATH}${path}`, {
      method,
      signal,
      credentials: 'include',
      headers: requestHeaders(body, headers),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (thrown) {
    throw new ApiUnavailableError(thrown);
  }

  if (!response.ok) {
    const { code, details } = await readError(response);

    throw new ApiError(response.status, code, details);
  }

  if (response.status === 204) return undefined as T;

  return unwrapEnvelope(await response.json()) as T;
}

function requestHeaders(
  body: unknown,
  extra: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const merged = {
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...extra,
  };

  return Object.keys(merged).length === 0 ? undefined : merged;
}

function unwrapEnvelope(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return body;

  const record = body as Record<string, unknown>;

  return record.success === true && 'data' in record ? record.data : body;
}

async function readError(
  response: Response,
): Promise<{ code: string | undefined; details: ApiErrorDetails }> {
  try {
    const body: unknown = await response.json();

    if (typeof body !== 'object' || body === null) {
      return { code: undefined, details: {} };
    }

    const record = body as Record<string, unknown>;
    const nested = record.error;
    const source =
      typeof nested === 'object' && nested !== null
        ? (nested as Record<string, unknown>)
        : record;

    return {
      code: typeof source.code === 'string' ? source.code : undefined,
      details: readDetails(source.details),
    };
  } catch {
    return { code: undefined, details: {} };
  }
}

function readDetails(value: unknown): ApiErrorDetails {
  if (typeof value !== 'object' || value === null) return {};

  const record = value as Record<string, unknown>;
  const details: ApiErrorDetails = {};

  if (
    Array.isArray(record.issues) &&
    record.issues.every((issue) => typeof issue === 'string')
  ) {
    details.issues = record.issues as string[];
  }

  if (typeof record.reason === 'string') details.reason = record.reason;

  return details;
}
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
