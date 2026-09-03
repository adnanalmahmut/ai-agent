import 'server-only';

import { headers } from 'next/headers';

import { API_BASE_PATH } from '@/config/paths';
import { serverConfig } from '@/config/server';
import { ApiError, ApiUnavailableError, type ApiErrorDetails } from '@/lib/application-api';

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
    const { code, details } = await readError(response);
    throw new ApiError(response.status, code, details);
  }

  if (response.status === 204) return null;
  return unwrapEnvelope(await response.json()) as T;
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
    const detailsValue = source.details;
    const details: ApiErrorDetails = {};

    if (typeof detailsValue === 'object' && detailsValue !== null) {
      const candidate = detailsValue as Record<string, unknown>;
      if (
        Array.isArray(candidate.issues) &&
        candidate.issues.every((issue) => typeof issue === 'string')
      ) {
        details.issues = candidate.issues;
      }
      if (typeof candidate.reason === 'string') details.reason = candidate.reason;
    }

    return {
      code: typeof source.code === 'string' ? source.code : undefined,
      details,
    };
  } catch {
    return { code: undefined, details: {} };
  }
}
