import 'server-only';

import { isStaffPrincipal } from '@/features/authorization/staff';

import { getServerSession } from './server-session';
import type { AdminSession } from './session-types';

/**
 * The one decision this workspace makes about a request, taken on the server
 * before anything protected renders.
 *
 * Four outcomes rather than two, because collapsing them loses information a
 * person needs: somebody who is signed in but not staff must not be sent to
 * a sign-in form, which would tell them they are signed out when they are
 * not, and an authorization that could not be evaluated at all must not read
 * as a refusal of the person.
 *
 * Every path other than `granted` is a denial. There is no branch here that
 * admits a request because something was missing.
 */
export type AdminAccess =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'granted'; readonly session: AdminSession }
  | { readonly kind: 'denied' }
  | { readonly kind: 'unavailable' };

export async function resolveAdminAccess(): Promise<AdminAccess> {
  let session: AdminSession | null;

  try {
    session = await getServerSession();
  } catch {
    // The session could not be established. Whether that is a broken API, a
    // broken deployment or something else is not knowable here, and none of
    // those is a reason to render an administrative surface.
    return { kind: 'unavailable' };
  }

  if (!session) return { kind: 'anonymous' };
  if (!isStaffPrincipal(session.user)) return { kind: 'denied' };

  return { kind: 'granted', session };
}
