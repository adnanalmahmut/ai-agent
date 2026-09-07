import 'server-only';

import { headers } from 'next/headers';
import { createServerTransport } from '@repo/api-client/server';

import { API_BASE_PATH } from '@/config/paths';
import { serverConfig } from '@/config/server';

/**
 * The Next adapter over the shared server transport.
 *
 * Reading the incoming request's cookie is the framework's job and stays
 * here; forwarding it, addressing the API and reading the answer is the
 * shared boundary's. That split is what keeps `next/headers` out of
 * `@repo/api-client`, and the package usable by an application that is not
 * this one.
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
