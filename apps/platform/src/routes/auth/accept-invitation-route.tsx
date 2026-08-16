import { useLoaderData } from 'react-router';

import { InvitationBlock } from '@/features/organization/blocks/invitation-block';
import { InvitationFailureCard } from '@/features/organization/components/invitation-failure-card';
import { InvitationSignInRequired } from '@/features/organization/components/invitation-sign-in-required';
import type { InvitationRouteData } from '@/features/organization/loaders';

/**
 * The destination of the invitation email.
 *
 * Public by placement — it sits outside the protected tree — but not open: the
 * invitation is read with the visitor's own session, and the backend declines
 * to describe it to anyone but the recipient. A visitor with no session is
 * shown why, and handed a sign-in link that returns them here.
 *
 * It stays under the authentication layout rather than the dashboard, and that
 * is a deliberate ordering: the reader may need to create an account before
 * they can accept, so framing the page in navigation for an application they
 * have not joined yet would be putting the shell before the door.
 */
export function AcceptInvitationRoute() {
  const data = useLoaderData<InvitationRouteData>();

  if (data.state === 'anonymous') {
    return <InvitationSignInRequired invitationPath={data.invitationPath} />;
  }

  // A link with no invitation id is not a failed invitation; it is not an
  // invitation. Saying so beats rendering a card about nothing.
  if (data.state === 'missing') {
    return <InvitationFailureCard failure="UNAVAILABLE" />;
  }

  if (!data.lookup.ok) {
    return <InvitationFailureCard failure={data.lookup.failure} />;
  }

  return <InvitationBlock invitation={data.lookup.invitation} />;
}
