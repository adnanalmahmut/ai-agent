import type { LoaderFunctionArgs } from 'react-router';

import { authClient } from '@/features/auth/auth-client';
import { INVITATION_ID_PARAM } from '@/features/auth/routes';
import { stripBasePath, stripLocalePrefix } from '@/i18n/routing';
import { firstParamOf } from '@/lib/search-params';

import {
  type InvitationLookup,
  invitationFailureFrom,
} from './invitation-state';
import { listArchivedOrganizations } from './organization-api';
import {
  type OrganizationError,
  organizationErrorFrom,
} from './organization-errors';
import type {
  ArchivedOrganization,
  FullOrganization,
  OrganizationSummary,
} from './organization-types';

/** Stable id, so the four organization tabs can share one fetch. */
export const ORGANIZATION_ROUTE_ID = 'organization';

/**
 * Route-level data for the organization feature.
 *
 * Loaders rather than effects, and the difference is visible on screen: a
 * loader's data exists before its route renders, so a members table appears
 * populated instead of appearing empty and then filling in. It also means
 * every one of these lists is refetched by a single `revalidate()` after a
 * mutation, with no cache to invalidate by hand.
 *
 * None of them throw on a failed request. A loader that threw would replace
 * the whole page with an error boundary, and "we could not load the member
 * list" is a message that belongs inside the page, next to a retry, with the
 * navigation still working.
 */

export type OrganizationsListData = {
  organizations: OrganizationSummary[];
  /** Empty when the archived read failed; never a reason to fail the page. */
  archived: ArchivedOrganization[];
  error: OrganizationError | null;
};

/**
 * The organizations the user belongs to, plus any they could restore.
 *
 * Two sources because they are two different questions with two different
 * owners: Better Auth knows about memberships, and only this application knows
 * what "archived" means. They are fetched together rather than in sequence —
 * the archived list is a small query and waiting for the first would make the
 * page a step slower for no reason.
 */
export async function organizationsLoader(): Promise<OrganizationsListData> {
  const [list, archived] = await Promise.allSettled([
    authClient.organization.list(),
    listArchivedOrganizations(),
  ]);

  if (list.status === 'rejected') {
    return {
      organizations: [],
      archived: [],
      error: organizationErrorFrom(list.reason),
    };
  }

  if (list.value.error) {
    return {
      organizations: [],
      archived: [],
      error: organizationErrorFrom({ error: list.value.error }),
    };
  }

  return {
    organizations: list.value.data ?? [],
    // A failure here is not worth failing the page for: the reader came to see
    // the organizations they are in, and the archived section is an extra.
    archived: archived.status === 'fulfilled' ? archived.value : [],
    error: null,
  };
}

export type OrganizationData =
  | { readonly state: 'ready'; readonly organization: FullOrganization }
  | {
      readonly state: 'archived';
      readonly organizationId: string;
      readonly restorable: ArchivedOrganization | null;
    }
  | { readonly state: 'error'; readonly error: OrganizationError };

/**
 * One organization, loaded once for all four of its tabs.
 *
 * `getFullOrganization` returns the organization, its members with their
 * users, and its invitations in a single response — so overview, members and
 * invitations read this same loader through `useRouteLoaderData` instead of
 * each issuing its own request for the same rows.
 *
 * The archived branch is the reason this returns a union rather than throwing.
 * The backend refuses every organization endpoint for an archived
 * organization, on purpose, which means the natural way to *discover* that one
 * is archived is to be refused. Turning that refusal into an error page would
 * leave the owner who archived it with no route back; instead the state is
 * named, and the restore affordance is offered when the server says this
 * caller may use it.
 */
export async function organizationLoader({
  params,
}: LoaderFunctionArgs): Promise<OrganizationData> {
  const organizationId = params.organizationId ?? '';

  try {
    const { data, error } = await authClient.organization.getFullOrganization({
      query: { organizationId },
    });

    if (error) {
      const failure = organizationErrorFrom({ error });

      if (failure === 'ORGANIZATION_ARCHIVED') {
        return {
          state: 'archived',
          organizationId,
          restorable: await findRestorable(organizationId),
        };
      }

      return { state: 'error', error: failure };
    }

    // A `null` body means the id matched nothing the caller may see. The
    // endpoint answers 200 with no organization rather than 404.
    if (!data) return { state: 'error', error: 'ORGANIZATION_NOT_FOUND' };

    return { state: 'ready', organization: data };
  } catch (thrown) {
    return { state: 'error', error: organizationErrorFrom(thrown) };
  }
}

/** Whether this caller may bring a specific archived organization back. */
async function findRestorable(
  organizationId: string,
): Promise<ArchivedOrganization | null> {
  try {
    const archived = await listArchivedOrganizations();

    return (
      archived.find(
        (organization) =>
          organization.id === organizationId && organization.canRestore,
      ) ?? null
    );
  } catch {
    // Not being able to answer "may you restore this" is not the same as
    // "no". The page says the organization is archived either way; it just
    // does not offer a button that might have worked.
    return null;
  }
}

/**
 * The invitation named in the URL, read with the visitor's own session.
 *
 * In a loader rather than in the block so the page arrives in its final state.
 * Someone who followed a link from an email is the least willing person in the
 * product to watch a spinner and the most likely to conclude the link is
 * broken.
 *
 * The backend is doing the deciding here, not this function.
 * `/organization/get-invitation` requires a session, checks that the signed-in
 * address matches the invited one, and refuses if the inviter has since left —
 * so a visitor who is not the recipient learns nothing about the organization,
 * whatever this page would have liked to show them.
 */
export type InvitationRouteData =
  | { readonly state: 'anonymous'; readonly invitationPath: string }
  | { readonly state: 'missing' }
  | { readonly state: 'loaded'; readonly lookup: InvitationLookup };

export async function invitationLoader({
  request,
}: LoaderFunctionArgs): Promise<InvitationRouteData> {
  const url = new URL(request.url);
  const invitationId = firstParamOf(url, INVITATION_ID_PARAM);

  // No id at all is not a failed invitation; it is not an invitation.
  if (!invitationId) return { state: 'missing' };

  // Where to come back to after signing in. Locale-free, because sign-in
  // re-applies one; base-free, because `basename` re-applies that.
  const invitationPath = `${stripLocalePrefix(stripBasePath(url.pathname))}${url.search}`;

  try {
    const { data, error } = await authClient.organization.getInvitation({
      query: { id: invitationId },
    });

    if (error) {
      // The one failure that is not about the invitation: nobody is signed in,
      // so the backend cannot tell whether this visitor is the recipient.
      if (error.status === 401) return { state: 'anonymous', invitationPath };

      return {
        state: 'loaded',
        lookup: { ok: false, failure: invitationFailureFrom({ error }) },
      };
    }

    if (!data) {
      return {
        state: 'loaded',
        lookup: { ok: false, failure: 'UNAVAILABLE' },
      };
    }

    return { state: 'loaded', lookup: { ok: true, invitation: data } };
  } catch (thrown) {
    return {
      state: 'loaded',
      lookup: { ok: false, failure: invitationFailureFrom(thrown) },
    };
  }
}
