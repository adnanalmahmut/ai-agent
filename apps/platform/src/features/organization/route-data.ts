import type { InvitationLookup } from './invitation-state';
import type { OrganizationError } from './organization-errors';
import type {
  ArchivedOrganization,
  FullOrganization,
  OrganizationBusinessProfile,
  OrganizationSummary,
} from './organization-types';

export type OrganizationBusinessProfileData = {
  profile: OrganizationBusinessProfile | null;
  error: OrganizationError | null;
};

export type OrganizationsListData = {
  organizations: OrganizationSummary[];
  /** Empty when the archived read failed; never a reason to fail the page. */
  archived: ArchivedOrganization[];
  error: OrganizationError | null;
};

export type OrganizationData =
  | { readonly state: 'ready'; readonly organization: FullOrganization }
  | {
      readonly state: 'archived';
      readonly organizationId: string;
      readonly restorable: ArchivedOrganization | null;
    }
  | { readonly state: 'error'; readonly error: OrganizationError };

export type InvitationRouteData =
  | { readonly state: 'anonymous'; readonly invitationPath: string }
  | { readonly state: 'missing' }
  | { readonly state: 'loaded'; readonly lookup: InvitationLookup };
