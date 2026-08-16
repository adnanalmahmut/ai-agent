import { useLoaderData } from 'react-router';

import { CreateOrganizationBlock } from '@/features/organization/blocks/create-organization-block';
import { OrganizationInvitationsBlock } from '@/features/organization/blocks/organization-invitations-block';
import { OrganizationMembersBlock } from '@/features/organization/blocks/organization-members-block';
import { OrganizationOverviewBlock } from '@/features/organization/blocks/organization-overview-block';
import { OrganizationSettingsBlock } from '@/features/organization/blocks/organization-settings-block';
import { OrganizationShellBlock } from '@/features/organization/blocks/organization-shell-block';
import { OrganizationsBlock } from '@/features/organization/blocks/organizations-block';
import type {
  OrganizationData,
  OrganizationsListData,
} from '@/features/organization/loaders';

/**
 * The organization routes.
 *
 * Thin by construction: a route reads its loader's data and renders a block.
 * The four tabs take no props at all — their layout has already resolved the
 * organization and passes it down through the outlet context, so each of them
 * is a single line.
 */

export function OrganizationsRoute() {
  return <OrganizationsBlock data={useLoaderData<OrganizationsListData>()} />;
}

export function NewOrganizationRoute() {
  return <CreateOrganizationBlock />;
}

export function OrganizationRoute() {
  return <OrganizationShellBlock data={useLoaderData<OrganizationData>()} />;
}

export function OrganizationOverviewRoute() {
  return <OrganizationOverviewBlock />;
}

export function OrganizationMembersRoute() {
  return <OrganizationMembersBlock />;
}

export function OrganizationInvitationsRoute() {
  return <OrganizationInvitationsBlock />;
}

export function OrganizationSettingsRoute() {
  return <OrganizationSettingsBlock />;
}
