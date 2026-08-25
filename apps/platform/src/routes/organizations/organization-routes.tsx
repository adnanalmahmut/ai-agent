import { useLoaderData } from 'react-router';

import { CreateOrganizationBlock } from '@/features/organization/blocks/create-organization-block';
import { OrganizationInvitationsBlock } from '@/features/organization/blocks/organization-invitations-block';
import { OrganizationKnowledgeBlock } from '@/features/organization/blocks/organization-knowledge-block';
import { OrganizationMembersBlock } from '@/features/organization/blocks/organization-members-block';
import { OrganizationOverviewBlock } from '@/features/organization/blocks/organization-overview-block';
import { OrganizationSettingsBlock } from '@/features/organization/blocks/organization-settings-block';
import { OrganizationShellBlock } from '@/features/organization/blocks/organization-shell-block';
import { OrganizationsBlock } from '@/features/organization/blocks/organizations-block';
import { useOrganizationContext } from '@/features/organization/organization-context';
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

/**
 * Keyed on the organization, so moving between two of them remounts.
 *
 * React Router reuses the component instance when only the path parameter
 * changes, and this block holds spaces, a chosen space, and that space's
 * documents. Without the key, navigating from one organization to another
 * renders the first one's material under the second one's heading until two
 * fetches resolve — with no loading state, because the block finished loading
 * for the organization it is no longer showing.
 */
export function OrganizationKnowledgeRoute() {
  const { organization } = useOrganizationContext();

  return <OrganizationKnowledgeBlock key={organization.id} />;
}

export function OrganizationSettingsRoute() {
  return <OrganizationSettingsBlock />;
}
