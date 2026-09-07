import { InvitationBlock } from '@/features/organization/blocks/invitation-block';
import { InvitationFailureCard } from '@/features/organization/components/invitation-failure-card';
import { InvitationSignInRequired } from '@/features/organization/components/invitation-sign-in-required';
import { getInvitationData } from '@/features/organization/server-data';
import { INVITATION_ID_PARAM, INVITATION_ROUTE } from '@/features/auth/routes';
import {
  firstRouteParam,
  routeSearchString,
  type RouteSearchParams,
} from '@/lib/route-search-params';

export default async function AcceptInvitationPage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const query = await searchParams;
  const search = routeSearchString(query);
  const data = await getInvitationData({
    invitationId: firstRouteParam(query, INVITATION_ID_PARAM),
    invitationPath: `${INVITATION_ROUTE}${search ? `?${search}` : ''}`,
  });

  if (data.state === 'anonymous') {
    return <InvitationSignInRequired invitationPath={data.invitationPath} />;
  }
  if (data.state === 'missing') {
    return <InvitationFailureCard failure="UNAVAILABLE" />;
  }
  if (!data.lookup.ok) {
    return <InvitationFailureCard failure={data.lookup.failure} />;
  }
  return <InvitationBlock invitation={data.lookup.invitation} />;
}
