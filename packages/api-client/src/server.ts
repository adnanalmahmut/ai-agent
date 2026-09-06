import { ApiError, ApiUnavailableError } from './errors';
import { readApiError, unwrapEnvelope } from './protocol';

export type ServerRequestOptions = {
  /**
   * The caller's cookie header, forwarded as it stands. Reading it is the
   * framework's job -- this package is handed the value rather than reaching
   * for `next/headers`, which is what keeps it out of a browser bundle and
   * out of the way of any application that is not Next.
   */
  cookie?: string | null;

  /**
   * Read a 401 as "nobody is signed in" and return null, rather than as a
   * failure. For the calls a signed-out page is allowed to make.
   */
  allowAnonymous?: boolean;
};

export type ServerApiRequest = <T>(
  path: string,
  options?: ServerRequestOptions,
) => Promise<T | null>;

/**
 * The server half of the transport: a cross-origin request to the API with
 * the caller's cookie forwarded and nothing cached.
 *
 * Same protocol as the browser half, same errors, same envelope. What differs
 * is where the credentials come from and that there is no same-origin proxy
 * in front, so the origin is explicit.
 */
export function createServerTransport(config: {
  origin: string;
  basePath: string;
}): ServerApiRequest {
  return async function serverApiRequest<T>(
    path: string,
    options: ServerRequestOptions = {},
  ): Promise<T | null> {
    const { cookie, allowAnonymous } = options;

    let response: Response;

    try {
      response = await fetch(`${config.origin}${config.basePath}${path}`, {
        cache: 'no-store',
        headers: cookie ? { cookie } : undefined,
      });
    } catch (thrown) {
      throw new ApiUnavailableError(thrown);
    }

    if (allowAnonymous && response.status === 401) return null;

    if (!response.ok) {
      const { code, details } = await readApiError(response);

      throw new ApiError(response.status, code, details);
    }

    if (response.status === 204) return null;

    return unwrapEnvelope(await response.json()) as T;
  };
}
