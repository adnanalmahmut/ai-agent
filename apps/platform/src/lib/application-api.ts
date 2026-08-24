import { API_BASE_PATH, CONTROL_PLANE_PATH } from '@/config/paths';

/**
 * The one place this application talks to a NestJS route.
 *
 * Better Auth's client owns everything that is authentication *protocol* —
 * sessions, organizations, members, invitations. What it does not own is this
 * application's own lifecycle endpoints, because archiving an organization is
 * a product decision the backend makes, not part of any auth specification.
 * Those live on ordinary Nest routes, and this module is how they are reached.
 *
 * It exists so that "call the backend" is a decision made once. A `fetch` in a
 * component would have to remember the base path, the credentials mode, the
 * JSON headers and the error shape; four things to get wrong, in every
 * component that forgot one. An architecture test asserts this is the only
 * module in the application that calls `fetch`.
 *
 * It is deliberately not a generated SDK or a client framework. Three
 * endpoints do not need one, and the shape below is small enough to read in
 * full before using it.
 */

/** The request never reached the server: offline, DNS, proxy down. */
export class ApiUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('The platform API could not be reached');
    this.name = 'ApiUnavailableError';
    this.cause = cause;
  }
}

/**
 * Operator-facing reasons a refusal carried, if it carried any.
 *
 * The backend distinguishes what a caller may be told from what it may not,
 * and puts the former in `error.details`. Two shapes reach this application: a
 * list of schema messages explaining why a bounded value was refused, and a
 * single sentence explaining why a credential did not look like one. Both
 * describe the *rule*, never the submitted value — that is a property the
 * backend maintains, and the reason these are safe to display.
 */
export type ApiErrorDetails = {
  issues?: string[];
  reason?: string;
};

/** The server answered, and the answer was a refusal. */
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
  /** Serialized as JSON. Omit for a bodyless request. */
  body?: unknown;
  signal?: AbortSignal;
  /**
   * Extra request headers, for the one endpoint that requires one.
   *
   * Content-idea generation demands an `Idempotency-Key`, because it is a
   * billed operation that is not naturally idempotent — a client retrying a
   * timed-out request without one would buy the same answer twice. That is a
   * per-request value rather than a property of this module, so it arrives
   * here instead of being invented here.
   */
  headers?: Record<string, string>;
};

/**
 * Calls an application endpoint and returns its parsed body.
 *
 * `credentials: 'include'` is belt and braces on a same-origin request, but it
 * is the difference between working and not if the platform is ever served
 * from a sibling host, and it costs nothing to state.
 *
 * The error body is read for a `code` and nothing else. The backend's
 * `UnifiedExceptionFilter` returns a localized message alongside it, but this
 * application renders its own copy in the reader's language — surfacing a
 * server-chosen sentence would mean two sources of truth for what the user
 * sees, in a locale the server only guessed at.
 */
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

/**
 * The headers to send, or none at all.
 *
 * `undefined` rather than an empty object when there is nothing to say. The
 * two are equivalent to `fetch`, but only one of them lets a test assert that
 * a bodyless request declares no content type — which is the property worth
 * holding, since declaring JSON on a request carrying none invites a proxy or
 * a framework to look for a body that is not there.
 */
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

/**
 * Takes the payload out of the backend's success envelope.
 *
 * Every non-204 response from a `/api/*` route is wrapped by the backend's
 * global `ResponseInterceptor` as `{ success: true, data, meta }`, and `data`
 * is what a caller asked for. Until the control plane there was nothing to
 * notice: every existing caller of this function returns `void`, so no body
 * had ever been read and returning the envelope was indistinguishable from
 * returning the payload.
 *
 * `meta` is deliberately dropped. It carries a request id and a timestamp,
 * plus pagination for the endpoints that paginate; nothing in this application
 * reads any of it, and returning a pair would make every call site unwrap
 * something it does not use. When a paginated screen needs it, this returns
 * the pair and the callers that want it say so — not before.
 *
 * A body that is not an envelope is returned as it stands, because
 * `@RawResponse()` endpoints exist and are not this function's business.
 */
function unwrapEnvelope(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return body;

  const record = body as Record<string, unknown>;

  return record.success === true && 'data' in record ? record.data : body;
}

/**
 * Reads the machine-readable code and the operator-facing reasons off a
 * failure, tolerating anything.
 *
 * A gateway that never reached Nest returns HTML; a crash returns an empty
 * body. Neither should turn a 502 into a parse exception on the way to an
 * error message.
 *
 * The server's localized `message` is still discarded: this application
 * renders its own sentence in the reader's language, and the server only
 * guessed at a locale. `details` is different — it is the *specific* reason,
 * which no generic client sentence can reproduce.
 */
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

/** Accepts only the two shapes this application knows how to display. */
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

/* ---------------------------- control plane ---------------------------- */

/**
 * The operator surface, typed against what the backend actually returns.
 *
 * Hand-written rather than generated, for the same reason the rest of this
 * module is: three resources do not need a code generator, and the types below
 * are short enough to check against the controller by reading them. What they
 * must not do is invent a field — in particular there is no secret value here,
 * because there is no endpoint that returns one.
 */

/**
 * Which layer decided a flag, listed rather than unioned so the copy naming
 * each one can be asserted to exist.
 */
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
  /** A row exists but no longer satisfies its schema, so the default is in force. */
  storedValueRejected: boolean;
  defaultValue: unknown;
  sensitivity: string;
  editable: boolean;
  updatedAt: string | undefined;
};

/**
 * Deliberately has no field a credential could occupy.
 *
 * Mirrors the backend type, which is shaped the same way for the same reason:
 * a read surface that cannot represent a plaintext cannot leak one by
 * forgetting to omit it.
 */
export type ManagedSecretDescription = {
  key: string;
  description: string;
  configured: boolean;
  label: string | undefined;
  algorithm: string | undefined;
  lastRotatedAt: string | undefined;
  updatedAt: string | undefined;
  /** False when the row was sealed under a different master key. */
  usable: boolean;
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

/**
 * Removes the override rather than writing the current default.
 *
 * The two are the same today and stop being the same the moment the code
 * default changes: a cleared flag follows the new default, a pinned one does
 * not. The screen offers both because an operator needs to express both.
 */
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

/**
 * Deactivates a user account via the NestJS application API.
 */
export async function deactivateUserAccount(userId: string): Promise<void> {
  await apiRequest(`/admin/users/${encodeURIComponent(userId)}/deactivate`, {
    method: 'POST',
  });
}

/**
 * Restores a deactivated user account via the NestJS application API.
 */
export async function restoreUserAccount(userId: string): Promise<void> {
  await apiRequest(`/admin/users/${encodeURIComponent(userId)}/restore`, {
    method: 'POST',
  });
}

/**
 * Deactivates the caller's own user account via the self-service application API.
 */
export async function deactivateSelfAccount(): Promise<void> {
  await apiRequest('/user/account/deactivate', {
    method: 'POST',
  });
}
