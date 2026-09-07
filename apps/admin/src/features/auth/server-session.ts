import 'server-only';

import { ApiError } from '@repo/api-client';

import { serverApiRequest } from '@/lib/api/server-request';

import type { AdminSession } from './session-types';

export async function getServerSession(): Promise<AdminSession | null> {
  try {
    return await serverApiRequest<AdminSession>('/auth/get-session', {
      allowAnonymous: true,
    });
  } catch (thrown) {
    if (thrown instanceof ApiError && thrown.status === 401) return null;
    throw thrown;
  }
}
