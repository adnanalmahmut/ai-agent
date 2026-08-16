import type { OrganizationContext } from '@/features/organization/organization-context';
import type {
  FullOrganization,
  OrganizationInvitation,
  OrganizationMember,
} from '@/features/organization/organization-types';

/**
 * Shared fixtures for the organization tests.
 *
 * One place, because the same organization is rendered by four blocks and a
 * layout: keeping five copies of it would mean five chances for a test to be
 * asserting about a shape the others do not have.
 */

export const VIEWER_ID = 'user_owner';

export function member(
  overrides: Partial<OrganizationMember> = {},
): OrganizationMember {
  return {
    id: 'member_owner',
    organizationId: 'org_1',
    userId: VIEWER_ID,
    role: 'owner',
    createdAt: '2026-01-15T10:00:00.000Z',
    user: {
      id: VIEWER_ID,
      name: 'Sara Haddad',
      email: 'sara@example.com',
      image: null,
    },
    ...overrides,
  };
}

export function invitation(
  overrides: Partial<OrganizationInvitation> = {},
): OrganizationInvitation {
  return {
    id: 'inv_1',
    organizationId: 'org_1',
    email: 'invitee@example.com',
    role: 'member',
    status: 'pending',
    inviterId: VIEWER_ID,
    expiresAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

export function organization(
  overrides: Partial<FullOrganization> = {},
): FullOrganization {
  return {
    id: 'org_1',
    name: 'Acme Research',
    slug: 'acme-research',
    logo: null,
    createdAt: '2026-01-01T10:00:00.000Z',
    members: [member()],
    invitations: [invitation()],
    ...overrides,
  };
}

/** The reader, as the tabs see them. Defaults to the organization's owner. */
export function context(
  overrides: Partial<OrganizationContext> = {},
): OrganizationContext {
  const org = overrides.organization ?? organization();

  return {
    organization: org,
    viewer: overrides.viewer ?? {
      userId: VIEWER_ID,
      member: org.members.find((row) => row.userId === VIEWER_ID) ?? null,
    },
  };
}
