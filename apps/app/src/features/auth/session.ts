import { ApiUnavailableError } from '@/lib/application-api';

import { authClient } from './auth-client';
import type { PlatformSession } from './session-types';

export async function fetchSession(): Promise<PlatformSession | null> {
  let result: Awaited<ReturnType<typeof authClient.getSession>>;

  try {
    result = await authClient.getSession({
      fetchOptions: { cache: 'no-store' },
    });
  } catch (thrown) {
    throw new ApiUnavailableError(thrown);
  }

  // Better Auth resolves rather than rejects for anything the server answered.
  // A 401 here is an anonymous visitor, which is a normal outcome; anything
  // else with no data is treated the same way, because the only decision this
  // function makes is "is there a session".
  if (result.error && isTransportFailure(result.error)) {
    throw new ApiUnavailableError(result.error);
  }

  return result.data ?? null;
}

function isTransportFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return true;

  const record = error as Record<string, unknown>;

  return typeof record.status !== 'number' && typeof record.code !== 'string';
}
