import type { OrganizationRoleName } from '@/features/authorization/permissions';

export type DateLike = string | Date;

export type OrganizationMember = {
  id: string;
  organizationId: string;
  userId: string;
  role: OrganizationRoleName;
  createdAt: DateLike;
  user: {
    id: string;
    email: string;
    name: string;
    image?: string | null;
  };
};

export type OrganizationInvitation = {
  id: string;
  organizationId: string;
  email: string;
  role: OrganizationRoleName;
  status: string;
  inviterId: string;
  expiresAt: DateLike;
};

export type FullOrganization = {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
  createdAt: DateLike;
  members: OrganizationMember[];
  invitations: OrganizationInvitation[];
};

export type OrganizationSummary = {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
};

export type ArchivedOrganization = {
  id: string;
  name: string;
  slug: string;
  archivedAt: string;
  canRestore: boolean;
};

export type OrganizationLifecycleResult = {
  organizationId: string;
  archivedAt: string | null;
  canceledInvitations: number;
  clearedActiveSessions: number;
};

export type OrganizationBusinessProfile = {
  organizationId: string;
  version: number;
  locale: 'ar' | 'en';
  timezone: string;
  currency: string;
  legalName: string | null;
  industry: string | null;
  websiteUrl: string | null;
  businessDescription: string | null;
  updatedAt: string;
};

export type ReplaceOrganizationBusinessProfile = Omit<
  OrganizationBusinessProfile,
  'organizationId' | 'updatedAt'
>;
