import 'server-only';

import { headers } from 'next/headers';
import { createServerTransport } from '@repo/api-client/server';

import { API_BASE_PATH } from '@/config/paths';
import { serverConfig } from '@/config/server';

/**
 * The Next adapter over the shared server transport, same split as the
 * customer application uses: reading the incoming request's cookie is the
 * framework's job and stays here, while addressing the API and reading the
 * answer belongs to `@repo/api-client`.
 */
const transport = createServerTransport({
  origin: serverConfig.apiOrigin,
  basePath: API_BASE_PATH,
});

export async function serverApiRequest<T>(
  path: string,
  options: { allowAnonymous?: boolean } = {},
): Promise<T | null> {
  const requestHeaders = await headers();

  return transport<T>(path, {
    cookie: requestHeaders.get('cookie'),
    allowAnonymous: options.allowAnonymous,
  });
}
