import 'server-only';

import { headers } from 'next/headers';

import { API_BASE_PATH } from '@/config/paths';
import { serverConfig } from '@/config/server';
import { ApiError, ApiUnavailableError } from '@/lib/application-api';
import { readApiError, unwrapEnvelope } from '@/lib/api/response-protocol';

export async function serverApiRequest<T>(
  path: string,
  options: { allowAnonymous?: boolean } = {},
): Promise<T | null> {
  const requestHeaders = await headers();
  const cookie = requestHeaders.get('cookie');
  let response: Response;

  try {
    response = await fetch(`${serverConfig.apiOrigin}${API_BASE_PATH}${path}`, {
      cache: 'no-store',
      headers: cookie ? { cookie } : undefined,
    });
  } catch (thrown) {
    throw new ApiUnavailableError(thrown);
  }

  if (options.allowAnonymous && response.status === 401) return null;

  if (!response.ok) {
    const { code, details } = await readApiError(response);
    throw new ApiError(response.status, code, details);
  }

  if (response.status === 204) return null;
  return unwrapEnvelope(await response.json()) as T;
}
