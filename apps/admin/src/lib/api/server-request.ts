import 'server-only';

import { headers } from 'next/headers';
import { createServerTransport } from '@repo/api-client/server';

import { API_BASE_PATH } from '@/config/paths';
import { apiOrigin } from '@/config/server';

/**
 * The Next adapter over the shared server transport, same split as the
 * customer application uses: reading the incoming request's cookie is the
 * framework's job and stays here, while addressing the API and reading the
 * answer belongs to `@repo/api-client`.
 *
 * The transport is built per call because the origin is a runtime input; the
 * factory only closes over a string, so there is nothing to reuse.
 */
export async function serverApiRequest<T>(
  path: string,
  options: { allowAnonymous?: boolean } = {},
): Promise<T | null> {
  const requestHeaders = await headers();
  const transport = createServerTransport({
    origin: apiOrigin(),
    basePath: API_BASE_PATH,
  });

  return transport<T>(path, {
    cookie: requestHeaders.get('cookie'),
    allowAnonymous: options.allowAnonymous,
  });
}
