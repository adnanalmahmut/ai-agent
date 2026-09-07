import 'server-only';

import { INVITATION_ID_PARAM } from '@/features/auth/routes';
import { ApiError } from '@/lib/application-api';
import { serverApiRequest } from '@/lib/api/server-request';

import {
  invitationFailureFrom,
  type InvitationDetails,
} from './invitation-state';
import { organizationErrorFrom } from './organization-errors';
import type {
  InvitationRouteData,
  OrganizationBusinessProfileData,
  OrganizationData,
  OrganizationsListData,
} from './route-data';
import type {
  ArchivedOrganization,
  FullOrganization,
  OrganizationBusinessProfile,
  OrganizationSummary,
} from './organization-types';

export async function getOrganizationsData(): Promise<OrganizationsListData> {
  const [organizations, archived] = await Promise.allSettled([
    serverApiRequest<OrganizationSummary[]>('/auth/organization/list'),
    serverApiRequest<ArchivedOrganization[]>('/organizations/archived'),
  ]);

  if (organizations.status === 'rejected') {
    return { organizations: [], archived: [], error: organizationErrorFrom(organizations.reason) };
  }

  return {
    organizations: organizations.value ?? [],
    archived: archived.status === 'fulfilled' ? (archived.value ?? []) : [],
    error: null,
  };
}

export async function getOrganizationData(
  organizationId: string,
): Promise<OrganizationData> {
  try {
    const organization = await serverApiRequest<FullOrganization>(
      `/auth/organization/get-full-organization?organizationId=${encodeURIComponent(organizationId)}`,
    );

    if (!organization) {
      return { state: 'error', error: 'ORGANIZATION_NOT_FOUND' };
    }
    return { state: 'ready', organization };
  } catch (thrown) {
    const failure = organizationErrorFrom(thrown);
    if (failure === 'ORGANIZATION_ARCHIVED') {
      return {
        state: 'archived',
        organizationId,
        restorable: await findRestorable(organizationId),
      };
    }
    return { state: 'error', error: failure };
  }
}

export async function getOrganizationBusinessProfileData(
  organizationId: string,
): Promise<OrganizationBusinessProfileData> {
  try {
    return {
      profile: await serverApiRequest<OrganizationBusinessProfile>(
        `/organizations/${encodeURIComponent(organizationId)}/business-profile`,
      ),
      error: null,
    };
  } catch (thrown) {
    return { profile: null, error: organizationErrorFrom(thrown) };
  }
}

async function findRestorable(
  organizationId: string,
): Promise<ArchivedOrganization | null> {
  try {
    const archived =
      (await serverApiRequest<ArchivedOrganization[]>('/organizations/archived')) ?? [];
    return (
      archived.find(
        (organization) =>
          organization.id === organizationId && organization.canRestore,
      ) ?? null
    );
  } catch {
    return null;
  }
}

export async function getInvitationData({
  invitationId,
  invitationPath,
}: {
  invitationId: string | undefined;
  invitationPath: string;
}): Promise<InvitationRouteData> {
  if (!invitationId) return { state: 'missing' };

  try {
    const invitation = await serverApiRequest<InvitationDetails>(
      `/auth/organization/get-invitation?${INVITATION_ID_PARAM}=${encodeURIComponent(invitationId)}`,
    );

    if (!invitation) {
      return { state: 'loaded', lookup: { ok: false, failure: 'UNAVAILABLE' } };
    }
    return { state: 'loaded', lookup: { ok: true, invitation } };
  } catch (thrown) {
    if (thrown instanceof ApiError && thrown.status === 401) {
      return { state: 'anonymous', invitationPath };
    }
    return {
      state: 'loaded',
      lookup: { ok: false, failure: invitationFailureFrom(thrown) },
    };
  }
}
