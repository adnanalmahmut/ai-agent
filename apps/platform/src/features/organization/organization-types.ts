import type { OrganizationRoleName } from '@/features/authorization/permissions';

/**
 * The organization shapes this application reads.
 *
 * Written out rather than inferred from the client, and the reason is worth
 * recording because inference was the first choice. Better Auth's organization
 * methods are generic in their fetch options, so `ReturnType<typeof
 * authClient.organization.list>` instantiates that parameter with its
 * constraint and collapses to `any` — a derived type that compiles, type-checks
 * nothing, and would have quietly let every field name in the UI be wrong.
 *
 * Declaring them here does not give up the drift protection, because the
 * loaders assign real responses to these types without a cast. A field the
 * server renames stops compiling at the assignment rather than at a `??` in a
 * component.
 *
 * They are deliberately *narrower* than the wire format: only what is
 * rendered. Better Auth also returns `metadata` and, with teams enabled,
 * `teams`; neither is used, and structural assignability means the extra
 * properties cost nothing.
 */

/**
 * A timestamp as it may arrive.
 *
 * Better Auth revives some date fields into `Date` objects and leaves others
 * as ISO strings depending on the endpoint. `new Date(…)` accepts both, so the
 * UI never has to know which — but pretending it is always one of the two
 * would be a type that is wrong half the time.
 */
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
  /** `pending` · `accepted` · `rejected` · `canceled`, per Better Auth. */
  status: string;
  inviterId: string;
  expiresAt: DateLike;
};

/** One organization, with its members and its invitations. */
export type FullOrganization = {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
  createdAt: DateLike;
  members: OrganizationMember[];
  invitations: OrganizationInvitation[];
};

/** As the switcher and the list see them: no members, no invitations. */
export type OrganizationSummary = {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
};

/**
 * An organization that has been taken offline.
 *
 * Archiving is this application's own lifecycle rather than a Better Auth
 * concept, so this shape comes from the NestJS endpoint.
 */
export type ArchivedOrganization = {
  id: string;
  name: string;
  slug: string;
  archivedAt: string;
  /** Whether *this* caller may bring it back. Decided by the server. */
  canRestore: boolean;
};

/** What the archive and restore endpoints report back. */
export type OrganizationLifecycleResult = {
  organizationId: string;
  archivedAt: string | null;
  canceledInvitations: number;
  clearedActiveSessions: number;
};
