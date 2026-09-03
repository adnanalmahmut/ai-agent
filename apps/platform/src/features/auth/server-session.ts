import 'server-only';

import { ApiError } from '@/lib/application-api';
import { serverApiRequest } from '@/lib/api/server-request';

import type { PlatformSession } from './session-types';

export async function getServerSession(): Promise<PlatformSession | null> {
  try {
    return await serverApiRequest<PlatformSession>('/auth/get-session', {
      allowAnonymous: true,
    });
  } catch (thrown) {
    if (thrown instanceof ApiError && thrown.status === 401) return null;
    throw thrown;
  }
}
