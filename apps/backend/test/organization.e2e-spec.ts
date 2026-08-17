import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Controller, Get } from '@nestjs/common';
import {
  MemberHasPermission,
  RequireActiveOrg,
} from '@thallesp/nestjs-better-auth';

import {
  as,
  createHarness,
  createUser,
  errorBody,
  signIn,
  type Harness,
  type TestUser,
} from './support/auth-harness';

/**
 * Probes for the organization authorization rules.
 *
 * `activeOrgOnly` is deliberately written the *wrong* way — it carries
 * `@RequireActiveOrg()` and nothing else. It exists only so a test can prove
 * that the precondition is not authorization. It lives here rather than in
 * `src/`, where the architecture test forbids exactly this shape.
 */
@Controller('probe/org')
class OrganizationProbeController {
  @Get('active-org-only')
  @RequireActiveOrg()
  activeOrgOnly() {
    return { reached: true };
  }

  @Get('read')
  @MemberHasPermission({ permissions: { organization: ['update'] } })
  read() {
    return { ok: true };
  }

  @Get('members')
  @MemberHasPermission({ permissions: { member: ['create'] } })
  members() {
    return { ok: true };
  }

  @Get('guarded')
  @RequireActiveOrg()
  @MemberHasPermission({ permissions: { organization: ['update'] } })
  guarded() {
    return { ok: true };
  }
}

/** Stands in for a business resource that must outlive membership changes. */
type ResourceFixture = { organizationId: string; createdByUserId: string };
const resources: ResourceFixture[] = [];

describe('Organizations (e2e)', () => {
  let harness: Harness;
  let owner: TestUser;
  let orgAdmin: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let superAdmin: TestUser;
  let organizationId: string;

  /** Creates an organization owned by `user` and returns its id. */
  const createOrganization = async (user: TestUser, name: string) => {
    const response = await as(harness, user).post(
      '/api/auth/organization/create',
      {
        name,
        slug: `${name.toLowerCase()}-${Date.now().toString(36)}-${Math.floor(
          Math.random() * 1e6,
        )}`,
      },
    );

    expect(response.status).toBe(200);
    return (response.body as { id: string }).id;
  };

  /**
   * Invites, accepts, and returns once the member row exists.
   *
   * The organization is always named explicitly rather than inherited from the
   * inviter's session: Better Auth *clears* `activeOrganizationId` when a
   * `set-active` membership check fails, so a suite that exercises that path
   * would otherwise leave later invitations pointing at nothing.
   */
  const addMember = async (
    inviter: TestUser,
    invitee: TestUser,
    role: string,
    targetOrganizationId?: string,
  ) => {
    const invite = await as(harness, inviter).post(
      '/api/auth/organization/invite-member',
      {
        email: invitee.email,
        role,
        organizationId: targetOrganizationId ?? organizationId,
      },
    );
    expect(invite.status).toBe(200);

    const invitationId = (invite.body as { id: string }).id;

    const accept = await as(harness, invitee).post(
      '/api/auth/organization/accept-invitation',
      { invitationId },
    );
    expect(accept.status).toBe(200);

    return invitationId;
  };

  const selectOrganization = (user: TestUser, id: string) =>
    as(harness, user).post('/api/auth/organization/set-active', {
      organizationId: id,
    });

  beforeAll(async () => {
    harness = await createHarness({
      controllers: [OrganizationProbeController],
    });

    owner = await createUser(harness);
    orgAdmin = await createUser(harness);
    member = await createUser(harness);
    outsider = await createUser(harness);
    superAdmin = await createUser(harness, { role: 'super_admin' });

    organizationId = await createOrganization(owner, 'Acme');

    await addMember(owner, orgAdmin, 'admin');
    await addMember(owner, member, 'member');

    await selectOrganization(orgAdmin, organizationId);
    await selectOrganization(member, organizationId);

    // A business resource owned by the organization and created by a member.
    resources.push({ organizationId, createdByUserId: member.id });
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  describe('creation and membership', () => {
    it('makes the creator an owner', async () => {
      const row = await harness.prisma.member.findFirst({
        where: { organizationId, userId: owner.id },
        select: { role: true },
      });

      expect(row?.role).toBe('owner');
    });

    it('sets the creator active organization', async () => {
      const sessions = await harness.prisma.session.findMany({
        where: { userId: owner.id },
        select: { activeOrganizationId: true },
      });

      expect(
        sessions.some((s) => s.activeOrganizationId === organizationId),
      ).toBe(true);
    });

    it('sends the invitation through MailService with a typed template', async () => {
      harness.transport.reset();

      const invitee = await createUser(harness);
      await as(harness, owner).post('/api/auth/organization/invite-member', {
        email: invitee.email,
        role: 'member',
        organizationId,
      });

      await harness.transport.settle();

      const sent = harness.transport.ofTemplate('ORGANIZATION_INVITATION');
      expect(sent).toHaveLength(1);
      expect(sent[0]?.to).toBe(invitee.email);
      expect(sent[0]?.html).toContain('/organizations/accept-invitation?id=');
    });
  });

  /**
   * The architectural rule this feature turns on, proven rather than asserted
   * in prose. A session can carry `activeOrganizationId` without the caller
   * being a member at all.
   */
  describe('@RequireActiveOrg is a precondition, not authorization', () => {
    it('fails the precondition with no organization selected', async () => {
      await as(harness, outsider).get('/probe/org/active-org-only').expect(403);
    });

    it('PASSES the precondition for a non-member with a stale selection', async () => {
      // Point a non-member's session at the organization directly. This is the
      // shape an attacker or a stale client would produce.
      await harness.prisma.session.updateMany({
        where: { userId: outsider.id },
        data: { activeOrganizationId: organizationId },
      });

      // The precondition is satisfied — which is exactly the problem.
      await as(harness, outsider).get('/probe/org/active-org-only').expect(200);
    });

    it('but authorization still refuses that same session', async () => {
      await harness.prisma.session.updateMany({
        where: { userId: outsider.id },
        data: { activeOrganizationId: organizationId },
      });

      await as(harness, outsider).get('/probe/org/read').expect(403);
      await as(harness, outsider).get('/probe/org/guarded').expect(403);
    });

    it('admits a real member on the same guarded route', async () => {
      await as(harness, orgAdmin).get('/probe/org/guarded').expect(200);
    });
  });

  describe('organization permissions', () => {
    it('lets an org admin update', async () => {
      await as(harness, orgAdmin).get('/probe/org/read').expect(200);
    });

    it('refuses a plain member', async () => {
      await as(harness, member).get('/probe/org/read').expect(403);
      await as(harness, member).get('/probe/org/members').expect(403);
    });

    it('lets an org admin manage members', async () => {
      await as(harness, orgAdmin).get('/probe/org/members').expect(200);
    });

    it('refuses a member who was never invited', async () => {
      const stranger = await createUser(harness);
      await harness.prisma.session.updateMany({
        where: { userId: stranger.id },
        data: { activeOrganizationId: organizationId },
      });

      await as(harness, stranger).get('/probe/org/read').expect(403);
    });
  });

  /** The two domains do not leak into each other in either direction. */
  describe('separation from global RBAC', () => {
    it('a global super_admin gains no organization permission', async () => {
      await harness.prisma.session.updateMany({
        where: { userId: superAdmin.id },
        data: { activeOrganizationId: organizationId },
      });

      await as(harness, superAdmin).get('/probe/org/read').expect(403);
    });

    it('an organization owner gains no platform permission', async () => {
      const response = await as(harness, owner).post(
        '/api/auth/admin/set-role',
        { userId: member.id, role: 'admin' },
      );

      expect(response.status).toBe(403);
    });

    it('an organization owner has the default global role', async () => {
      const row = await harness.prisma.user.findUnique({
        where: { id: owner.id },
        select: { role: true },
      });

      expect(row?.role).toBe('user');
    });
  });

  describe('cross-organization isolation', () => {
    it('refuses selecting an organization the caller does not belong to', async () => {
      const other = await createUser(harness);
      const otherOrg = await createOrganization(other, 'Other');

      const response = await selectOrganization(owner, otherOrg);
      expect(response.status).toBe(403);
    });

    it('clears the selection when the membership check fails', async () => {
      const other = await createUser(harness);
      const otherOrg = await createOrganization(other, 'Third');

      await selectOrganization(member, otherOrg);

      const sessions = await harness.prisma.session.findMany({
        where: { userId: member.id },
        select: { activeOrganizationId: true },
      });
      expect(sessions.every((s) => s.activeOrganizationId !== otherOrg)).toBe(
        true,
      );
    });
  });

  /**
   * Membership is current access state: the row exists or it does not. Better
   * Auth reads existence, so a `deletedAt` column on `member` would still look
   * like membership to it.
   */
  describe('membership lifecycle', () => {
    it('removes the row, and access with it, while preserving resources', async () => {
      const transient = await createUser(harness);
      await addMember(owner, transient, 'admin');
      await selectOrganization(transient, organizationId);

      resources.push({ organizationId, createdByUserId: transient.id });
      const resourcesBefore = resources.length;

      await as(harness, transient).get('/probe/org/read').expect(200);

      await as(harness, orgAdmin)
        .post('/api/auth/organization/remove-member', {
          memberIdOrEmail: transient.email,
          organizationId,
        })
        .expect(200);

      await expect(
        harness.prisma.member.count({
          where: { organizationId, userId: transient.id },
        }),
      ).resolves.toBe(0);

      // Immediately, with no cache in the way.
      await as(harness, transient).get('/probe/org/read').expect(403);

      // Nothing the user created disappeared with the membership.
      expect(resources).toHaveLength(resourcesBefore);
      expect(resources.some((r) => r.createdByUserId === transient.id)).toBe(
        true,
      );

      // And the identity itself is untouched.
      await expect(
        harness.prisma.user.count({ where: { id: transient.id } }),
      ).resolves.toBe(1);
    });

    it('reactivates through a fresh invitation, keeping the same user', async () => {
      const returning = await createUser(harness);
      await addMember(owner, returning, 'admin');

      await as(harness, orgAdmin)
        .post('/api/auth/organization/remove-member', {
          memberIdOrEmail: returning.email,
          organizationId,
        })
        .expect(200);

      await addMember(owner, returning, 'member');

      const row = await harness.prisma.member.findFirst({
        where: { organizationId, userId: returning.id },
        select: { role: true, userId: true },
      });

      expect(row?.userId).toBe(returning.id);
      // The new role, not the old one — reactivation is a fresh grant.
      expect(row?.role).toBe('member');
    });
  });

  describe('invitation lifecycle', () => {
    it('rejects an invitation', async () => {
      const invitee = await createUser(harness);
      const invite = await as(harness, owner).post(
        '/api/auth/organization/invite-member',
        { email: invitee.email, role: 'member', organizationId },
      );
      expect(invite.status).toBe(200);
      const invitationId = (invite.body as { id: string }).id;

      await as(harness, invitee)
        .post('/api/auth/organization/reject-invitation', { invitationId })
        .expect(200);

      const row = await harness.prisma.invitation.findUnique({
        where: { id: invitationId },
        select: { status: true },
      });
      expect(row?.status).toBe('rejected');
    });

    it('cancels an invitation as an org admin', async () => {
      const invitee = await createUser(harness, { signIn: false });
      const invite = await as(harness, owner).post(
        '/api/auth/organization/invite-member',
        { email: invitee.email, role: 'member', organizationId },
      );
      expect(invite.status).toBe(200);
      const invitationId = (invite.body as { id: string }).id;

      await as(harness, orgAdmin)
        .post('/api/auth/organization/cancel-invitation', { invitationId })
        .expect(200);

      const row = await harness.prisma.invitation.findUnique({
        where: { id: invitationId },
        select: { status: true },
      });
      expect(row?.status).toBe('canceled');
    });

    it('refuses to let a plain member invite', async () => {
      const invitee = await createUser(harness, { signIn: false });

      const response = await as(harness, member).post(
        '/api/auth/organization/invite-member',
        { email: invitee.email, role: 'member', organizationId },
      );

      expect(response.status).toBe(403);
    });
  });

  /**
   * The strict security boundary: organization authority is not platform
   * authority. An owner must not be able to reactivate a globally
   * deactivated account by inviting it.
   */
  describe('a soft-deleted account cannot be revived by an invitation', () => {
    it('leaves the account deactivated and unusable', async () => {
      const victim = await createUser(harness);

      await as(harness, superAdmin)
        .post(`/admin/users/${victim.id}/deactivate`)
        .expect(201);

      // The owner may still create the invitation — the organization knows
      // nothing about platform account state, and refusing here would leak it.
      const invite = await as(harness, owner).post(
        '/api/auth/organization/invite-member',
        { email: victim.email, role: 'member', organizationId },
      );
      expect(invite.status).toBe(200);
      const invitationId = (invite.body as { id: string }).id;

      // But the account is still deactivated...
      const row = await harness.prisma.user.findUnique({
        where: { id: victim.id },
        select: { deletedAt: true },
      });
      expect(row?.deletedAt).not.toBeNull();

      // ...and cannot obtain a session, so the invitation cannot be accepted.
      await expect(
        harness.prisma.session.count({ where: { userId: victim.id } }),
      ).resolves.toBe(0);

      // The invitation stays pending, waiting for a platform-level restore.
      const invitation = await harness.prisma.invitation.findUnique({
        where: { id: invitationId },
        select: { status: true },
      });
      expect(invitation?.status).toBe('pending');

      // After a super_admin restores the account, the same pending invitation
      // works — restore reopens the platform gate and nothing more.
      await as(harness, superAdmin)
        .post(`/admin/users/${victim.id}/restore`)
        .expect(201);

      const cookie = await signIn(harness, victim.email, victim.password);

      await as(harness, { cookie })
        .post('/api/auth/organization/accept-invitation', { invitationId })
        .expect(200);

      await expect(
        harness.prisma.member.count({
          where: { organizationId, userId: victim.id },
        }),
      ).resolves.toBe(1);
    });
  });

  /**
   * Archive is the organization lifecycle. Hard deletion is disabled twice
   * over — no role holds `organization:delete`, and the route itself is off.
   */
  describe('archive and restore', () => {
    let archivedOrg: string;
    let archiveOwner: TestUser;
    let archiveAdmin: TestUser;
    let archiveMember: TestUser;
    let pendingInvitationId: string;
    let resourceCount: number;

    beforeAll(async () => {
      archiveOwner = await createUser(harness);
      archiveAdmin = await createUser(harness);
      archiveMember = await createUser(harness);

      archivedOrg = await createOrganization(archiveOwner, 'Archivable');
      await addMember(archiveOwner, archiveAdmin, 'admin', archivedOrg);
      await addMember(archiveOwner, archiveMember, 'member', archivedOrg);
      await selectOrganization(archiveAdmin, archivedOrg);
      await selectOrganization(archiveMember, archivedOrg);

      const pendingInvitee = await createUser(harness, { signIn: false });
      const invite = await as(harness, archiveOwner).post(
        '/api/auth/organization/invite-member',
        {
          email: pendingInvitee.email,
          role: 'member',
          organizationId: archivedOrg,
        },
      );
      expect(invite.status).toBe(200);
      pendingInvitationId = (invite.body as { id: string }).id;

      resources.push({
        organizationId: archivedOrg,
        createdByUserId: archiveMember.id,
      });
      resourceCount = resources.length;
    }, 120_000);

    it('refuses Better Auth hard deletion to the owner', async () => {
      const response = await as(harness, archiveOwner).post(
        '/api/auth/organization/delete',
        { organizationId: archivedOrg },
      );

      // `disableOrganizationDeletion: true` answers 404 rather than 403 — the
      // route is not merely forbidden, it is not there.
      expect(response.status).toBe(404);

      await expect(
        harness.prisma.organization.count({ where: { id: archivedOrg } }),
      ).resolves.toBe(1);
    });

    it('refuses archive to an org admin', async () => {
      await as(harness, archiveAdmin)
        .post(`/organizations/${archivedOrg}/archive`)
        .expect(403);
    });

    it('refuses archive to a plain member', async () => {
      await as(harness, archiveMember)
        .post(`/organizations/${archivedOrg}/archive`)
        .expect(403);
    });

    it('archives for the owner, recording the actor and reason', async () => {
      await as(harness, archiveOwner)
        .post(`/organizations/${archivedOrg}/archive`, { reason: 'wound down' })
        .expect(201);

      const row = await harness.prisma.organization.findUnique({
        where: { id: archivedOrg },
        select: {
          archivedAt: true,
          archivedByUserId: true,
          archiveReason: true,
        },
      });

      expect(row?.archivedAt).toBeInstanceOf(Date);
      expect(row?.archivedByUserId).toBe(archiveOwner.id);
      expect(row?.archiveReason).toBe('wound down');
    });

    it('destroys nothing', async () => {
      await expect(
        harness.prisma.organization.count({ where: { id: archivedOrg } }),
      ).resolves.toBe(1);
      await expect(
        harness.prisma.member.count({ where: { organizationId: archivedOrg } }),
      ).resolves.toBe(3);
      await expect(
        harness.prisma.invitation.count({
          where: { organizationId: archivedOrg },
        }),
      ).resolves.toBeGreaterThan(0);

      expect(resources).toHaveLength(resourceCount);
    });

    it('clears every session that had it selected', async () => {
      const stillSelected = await harness.prisma.session.count({
        where: { activeOrganizationId: archivedOrg },
      });

      expect(stillSelected).toBe(0);
    });

    it('cancels pending invitations without deleting them', async () => {
      const row = await harness.prisma.invitation.findUnique({
        where: { id: pendingInvitationId },
        select: { status: true },
      });

      expect(row?.status).toBe('canceled');
    });

    describe('an archived organization is inert', () => {
      it('cannot be selected', async () => {
        const response = await selectOrganization(archiveOwner, archivedOrg);
        expect(response.status).toBe(403);
        expect(JSON.stringify(response.body)).toContain(
          'ORGANIZATION_ARCHIVED',
        );
      });

      it('cannot be updated', async () => {
        const response = await as(harness, archiveOwner).post(
          '/api/auth/organization/update',
          { organizationId: archivedOrg, data: { name: 'Renamed' } },
        );
        expect(response.status).toBe(403);
      });

      it('cannot issue invitations', async () => {
        const invitee = await createUser(harness, { signIn: false });

        const response = await as(harness, archiveOwner).post(
          '/api/auth/organization/invite-member',
          {
            email: invitee.email,
            role: 'member',
            organizationId: archivedOrg,
          },
        );

        expect(response.status).toBe(403);
      });

      /**
       * An invitation issued *before* the archive must not become a way in.
       * The hook resolves the organization from the invitation for exactly
       * this case.
       */
      it('cannot have a pre-existing invitation accepted', async () => {
        const invitee = await createUser(harness);

        // Re-open the canceled invitation directly, simulating a link that was
        // already in someone's inbox when the archive happened.
        const revived = await harness.prisma.invitation.create({
          data: {
            organizationId: archivedOrg,
            email: invitee.email,
            role: 'member',
            status: 'pending',
            expiresAt: new Date(Date.now() + 3_600_000),
            inviterId: archiveOwner.id,
          },
          select: { id: true },
        });

        const response = await as(harness, invitee).post(
          '/api/auth/organization/accept-invitation',
          { invitationId: revived.id },
        );

        expect(response.status).toBe(403);
        await expect(
          harness.prisma.member.count({
            where: { organizationId: archivedOrg, userId: invitee.id },
          }),
        ).resolves.toBe(0);
      });

      it('cannot mutate members', async () => {
        const response = await as(harness, archiveOwner).post(
          '/api/auth/organization/remove-member',
          { memberIdOrEmail: archiveMember.email, organizationId: archivedOrg },
        );

        expect(response.status).toBe(403);
      });

      /**
       * The point of putting enforcement in one Better Auth hook: application
       * routes authorize through `/organization/has-permission`, so they become
       * inert too without a single check of their own.
       */
      it('denies application resource access', async () => {
        await harness.prisma.session.updateMany({
          where: { userId: archiveAdmin.id },
          data: { activeOrganizationId: archivedOrg },
        });

        await as(harness, archiveAdmin).get('/probe/org/read').expect(403);
        await as(harness, archiveAdmin).get('/probe/org/guarded').expect(403);
      });

      it('is hidden from the organization list', async () => {
        const response = await as(harness, archiveOwner).get(
          '/api/auth/organization/list',
        );

        expect(response.status).toBe(200);
        const ids = (response.body as { id: string }[]).map((o) => o.id);
        expect(ids).not.toContain(archivedOrg);
      });
    });

    /**
     * The read that exists because `/organization/list` cannot answer it.
     *
     * Archived organizations are filtered out of Better Auth's list on
     * purpose, which is correct and leaves one gap: without this endpoint an
     * owner who archived an organization would have no way to find it again.
     * Every assertion below is about who may see what, because that is the
     * only thing the endpoint decides.
     */
    describe('listing archived organizations', () => {
      type ArchivedRow = { id: string; canRestore: boolean };

      const archivedRows = (body: unknown): ArchivedRow[] => {
        if (body && typeof body === 'object' && 'data' in body) {
          return (body as { data: ArchivedRow[] }).data ?? [];
        }
        return (body as ArchivedRow[]) ?? [];
      };

      const archivedIds = (body: unknown) =>
        archivedRows(body).map((row) => row.id);

      it('shows it to the owner, marked restorable', async () => {
        const response = await as(harness, archiveOwner).get(
          '/organizations/archived',
        );

        expect(response.status).toBe(200);

        const row = archivedRows(response.body).find(
          (candidate) => candidate.id === archivedOrg,
        );

        expect(row).toBeDefined();
        expect(row?.canRestore).toBe(true);
      });

      it('hides it from an org admin, who cannot restore it', async () => {
        // Admins run the organization day to day; archiving and restoring are
        // withheld from them, so an entry they could not act on would be an
        // offer of a 403.
        const response = await as(harness, archiveAdmin).get(
          '/organizations/archived',
        );

        expect(response.status).toBe(200);
        expect(archivedIds(response.body)).not.toContain(archivedOrg);
      });

      it('hides it from a plain member', async () => {
        const response = await as(harness, archiveMember).get(
          '/organizations/archived',
        );

        expect(archivedIds(response.body)).not.toContain(archivedOrg);
      });

      it('hides it from an unrelated user', async () => {
        const response = await as(harness, outsider).get(
          '/organizations/archived',
        );

        expect(archivedIds(response.body)).not.toContain(archivedOrg);
      });

      it('shows it to a platform recoverer who is not a member', async () => {
        // `organizationLifecycle:restore` is the platform authority, and it
        // is the reason this row is visible without a membership.
        const response = await as(harness, superAdmin).get(
          '/organizations/archived',
        );

        const row = archivedRows(response.body).find(
          (candidate) => candidate.id === archivedOrg,
        );

        expect(row?.canRestore).toBe(true);
      });

      it('refuses an anonymous caller outright', async () => {
        await as(harness, { cookie: '' })
          .get('/organizations/archived')
          .expect(401);
      });
    });

    describe('restore by the owner', () => {
      it('refuses a plain member', async () => {
        await as(harness, archiveMember)
          .post(`/organizations/${archivedOrg}/restore`)
          .expect(403);
      });

      it('refuses an org admin', async () => {
        await as(harness, archiveAdmin)
          .post(`/organizations/${archivedOrg}/restore`)
          .expect(403);
      });

      it('refuses an unrelated user', async () => {
        await as(harness, outsider)
          .post(`/organizations/${archivedOrg}/restore`)
          .expect(403);
      });

      it('succeeds for the owner and brings the organization back', async () => {
        await as(harness, archiveOwner)
          .post(`/organizations/${archivedOrg}/restore`)
          .expect(201);

        const row = await harness.prisma.organization.findUnique({
          where: { id: archivedOrg },
          select: { id: true, archivedAt: true },
        });

        expect(row?.id).toBe(archivedOrg);
        expect(row?.archivedAt).toBeNull();
      });

      it('keeps members and resources', async () => {
        await expect(
          harness.prisma.member.count({
            where: { organizationId: archivedOrg },
          }),
        ).resolves.toBe(3);
        expect(resources).toHaveLength(resourceCount);
      });

      it('drops out of the archived list once it is back', async () => {
        const response = await as(harness, archiveOwner).get(
          '/organizations/archived',
        );

        const rows =
          response.body &&
          typeof response.body === 'object' &&
          'data' in response.body
            ? (response.body as { data: { id: string }[] }).data
            : (response.body as { id: string }[]);
        expect((rows ?? []).map((row) => row.id)).not.toContain(archivedOrg);
      });

      it('leaves invitations canceled by the archive canceled', async () => {
        const row = await harness.prisma.invitation.findUnique({
          where: { id: pendingInvitationId },
          select: { status: true },
        });

        expect(row?.status).toBe('canceled');
      });

      it('accepts a new invitation after the restore', async () => {
        const invitee = await createUser(harness);

        await selectOrganization(archiveOwner, archivedOrg);

        const invite = await as(harness, archiveOwner).post(
          '/api/auth/organization/invite-member',
          { email: invitee.email, role: 'member', organizationId: archivedOrg },
        );
        expect(invite.status).toBe(200);

        await as(harness, invitee)
          .post('/api/auth/organization/accept-invitation', {
            invitationId: (invite.body as { id: string }).id,
          })
          .expect(200);
      });

      it('is idempotent with a stable error code', async () => {
        const response = await as(harness, archiveOwner).post(
          `/organizations/${archivedOrg}/restore`,
        );

        expect(response.status).toBe(409);
        expect(errorBody(response).errorCode).toBe('ORGANIZATION_NOT_ARCHIVED');
      });
    });

    describe('platform recovery by super_admin', () => {
      it('restores an archived organization without membership', async () => {
        await as(harness, archiveOwner)
          .post(`/organizations/${archivedOrg}/archive`)
          .expect(201);

        await as(harness, superAdmin)
          .post(`/organizations/${archivedOrg}/restore`)
          .expect(201);

        const row = await harness.prisma.organization.findUnique({
          where: { id: archivedOrg },
          select: { archivedAt: true },
        });
        expect(row?.archivedAt).toBeNull();
      });

      it('gains no membership from the recovery', async () => {
        await expect(
          harness.prisma.member.count({
            where: { organizationId: archivedOrg, userId: superAdmin.id },
          }),
        ).resolves.toBe(0);
      });

      it('gains no organization permission from the recovery', async () => {
        await harness.prisma.session.updateMany({
          where: { userId: superAdmin.id },
          data: { activeOrganizationId: archivedOrg },
        });

        await as(harness, superAdmin).get('/probe/org/read').expect(403);
        await as(harness, superAdmin).get('/probe/org/members').expect(403);
      });

      it('cannot archive an organization it does not own', async () => {
        await as(harness, superAdmin)
          .post(`/organizations/${archivedOrg}/archive`)
          .expect(403);
      });

      it('reports an already-active organization with a stable code', async () => {
        const response = await as(harness, superAdmin).post(
          `/organizations/${archivedOrg}/restore`,
        );

        expect(response.status).toBe(409);
        expect(errorBody(response).errorCode).toBe('ORGANIZATION_NOT_ARCHIVED');
      });
    });
  });
});
