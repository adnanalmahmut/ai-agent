import { ApiError, ApiUnavailableError } from './errors';
import { readApiError, unwrapEnvelope } from './protocol';

export type BrowserRequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

export type BrowserApiRequest = <T>(
  path: string,
  options?: BrowserRequestOptions,
) => Promise<T>;

/**
 * The browser half of the transport: a same-origin request that carries the
 * session cookie, unwraps the success envelope, and turns a refusal into an
 * `ApiError` carrying the code and details the API declared.
 *
 * The base path is passed in rather than read from a config module, because
 * an application's routing is the application's business — a package that
 * imported it would be one that only one application could use.
 */
export function createBrowserTransport(config: {
  basePath: string;
}): BrowserApiRequest {
  return async function apiRequest<T>(
    path: string,
    options: BrowserRequestOptions = {},
  ): Promise<T> {
    const { method = 'GET', body, signal, headers } = options;

    let response: Response;

    try {
      response = await fetch(`${config.basePath}${path}`, {
        method,
        signal,
        credentials: 'include',
        headers: requestHeaders(body, headers),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (thrown) {
      // An aborted request lands here too. It is the same fact from the
      // caller's side -- no answer arrived -- and the `cause` says which.
      throw new ApiUnavailableError(thrown);
    }

    if (!response.ok) {
      const { code, details } = await readApiError(response);

      throw new ApiError(response.status, code, details);
    }

    if (response.status === 204) return undefined as T;

    return unwrapEnvelope(await response.json()) as T;
  };
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
