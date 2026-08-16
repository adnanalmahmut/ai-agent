import { API_BASE_PATH } from '@/config/paths';

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

/** The server answered, and the answer was a refusal. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(`Platform API responded with ${status}`);
    this.name = 'ApiError';
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST';
  /** Serialized as JSON. Omit for a bodyless request. */
  body?: unknown;
  signal?: AbortSignal;
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
  const { method = 'GET', body, signal } = options;

  let response: Response;

  try {
    response = await fetch(`${API_BASE_PATH}${path}`, {
      method,
      signal,
      credentials: 'include',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (thrown) {
    throw new ApiUnavailableError(thrown);
  }

  if (!response.ok) {
    throw new ApiError(response.status, await readErrorCode(response));
  }

  if (response.status === 204) return undefined as T;

  return (await response.json()) as T;
}

/**
 * Reads the machine-readable code off a failure, tolerating anything.
 *
 * A gateway that never reached Nest returns HTML; a crash returns an empty
 * body. Neither should turn a 502 into a parse exception on the way to an
 * error message.
 */
async function readErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();

    if (typeof body !== 'object' || body === null) return undefined;

    const record = body as Record<string, unknown>;
    const nested = record.error;
    const source =
      typeof nested === 'object' && nested !== null
        ? (nested as Record<string, unknown>)
        : record;

    return typeof source.code === 'string' ? source.code : undefined;
  } catch {
    return undefined;
  }
}
