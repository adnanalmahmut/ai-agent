import { vi } from 'vitest';

/**
 * A stand-in for the Better Auth client.
 *
 * The real client opens a broadcast channel, mounts nanostores and talks to a
 * server; none of that belongs in a component test. What matters is the
 * contract the components depend on, so the stub mirrors its *shape* exactly
 * — a call that returns `{ data, error }`, hooks that return
 * `{ data, isPending }` — and a test that drifts from that shape fails here
 * rather than in production.
 */

type Result<T> = { data: T | null; error?: unknown };

/** The shape both `checkRolePermission` calls take. */
type PermissionRequest = { role: string; permissions: Record<string, string[]> };

/** What a reactive Better Auth hook returns. */
type Atom<T> = { data: T | null; isPending: boolean };

type SessionShape = { user: Record<string, unknown> };
type MemberShape = { role: string };
type OrganizationShape = { id: string; name: string };

export const ok = <T,>(data: T): Result<T> => ({ data, error: undefined });
export const fail = (code: string, status = 400): Result<never> => ({
  data: null,
  error: { code, status, message: 'stub failure' },
});

export const authClientStub = {
  signIn: {
    email: vi.fn(async () => ok({ redirect: false })),
    social: vi.fn(async () => ok({ url: 'https://accounts.google.com/o/oauth2' })),
  },
  signUp: {
    email: vi.fn(async () => ok({ token: null })),
  },
  signOut: vi.fn(async () => ok({ success: true })),
  sendVerificationEmail: vi.fn(async () => ok({ status: true })),
  requestPasswordReset: vi.fn(async () => ok({ status: true })),
  resetPassword: vi.fn(async () => ok({ status: true })),
  getSession: vi.fn(async () => ok(null)),

  useSession: vi.fn((): Atom<SessionShape> => ({ data: null, isPending: false })),
  useActiveMember: vi.fn((): Atom<MemberShape> => ({
    data: null,
    isPending: false,
  })),
  useActiveOrganization: vi.fn((): Atom<OrganizationShape> => ({
    data: null,
    isPending: false,
  })),
  useListOrganizations: vi.fn((): Atom<OrganizationShape[]> => ({
    data: [],
    isPending: false,
  })),

  admin: {
    checkRolePermission: vi.fn((_request: PermissionRequest) => false),
    listUsers: vi.fn(async () => ok({ users: [] as unknown[], total: 0 })),
    setRole: vi.fn(async () => ok({ status: true })),
    banUser: vi.fn(async () => ok({ status: true })),
    unbanUser: vi.fn(async () => ok({ status: true })),
    impersonateUser: vi.fn(async () => ok({ status: true })),
  },
  organization: {
    checkRolePermission: vi.fn((_request: PermissionRequest) => false),
    setActive: vi.fn(async () => ok({ id: 'org_1' })),
    acceptInvitation: vi.fn(async () => ok({ invitation: {}, member: {} })),
    rejectInvitation: vi.fn(async () => ok({ invitation: {} })),
    getInvitation: vi.fn(async () => ok(null)),

    list: vi.fn(async () => ok([] as unknown[])),
    create: vi.fn(async () => ok({ id: 'org_new' })),
    update: vi.fn(async () => ok({ id: 'org_1' })),
    checkSlug: vi.fn(async () => ok({ status: true })),
    getFullOrganization: vi.fn(async () => ok(null)),
    inviteMember: vi.fn(async () => ok({ id: 'inv_1' })),
    cancelInvitation: vi.fn(async () => ok({ id: 'inv_1' })),
    updateMemberRole: vi.fn(async () => ok({ id: 'member_1' })),
    removeMember: vi.fn(async () => ok({ member: { id: 'member_1' } })),
  },
};

/** Restores every stub to its default so one test cannot leak into the next. */
export function resetAuthClientStub() {
  authClientStub.signIn.email.mockResolvedValue(ok({ redirect: false }));
  authClientStub.signIn.social.mockResolvedValue(
    ok({ url: 'https://accounts.google.com/o/oauth2' }),
  );
  authClientStub.signUp.email.mockResolvedValue(ok({ token: null }));
  authClientStub.signOut.mockResolvedValue(ok({ success: true }));
  authClientStub.sendVerificationEmail.mockResolvedValue(ok({ status: true }));
  authClientStub.requestPasswordReset.mockResolvedValue(ok({ status: true }));
  authClientStub.resetPassword.mockResolvedValue(ok({ status: true }));

  authClientStub.useSession.mockReturnValue({ data: null, isPending: false });
  authClientStub.useActiveMember.mockReturnValue({
    data: null,
    isPending: false,
  });
  authClientStub.useActiveOrganization.mockReturnValue({
    data: null,
    isPending: false,
  });
  authClientStub.useListOrganizations.mockReturnValue({
    data: [],
    isPending: false,
  });

  authClientStub.admin.checkRolePermission.mockReturnValue(false);
  authClientStub.admin.listUsers.mockResolvedValue(ok({ users: [], total: 0 }));
  authClientStub.admin.setRole.mockResolvedValue(ok({ status: true }));
  authClientStub.admin.banUser.mockResolvedValue(ok({ status: true }));
  authClientStub.admin.unbanUser.mockResolvedValue(ok({ status: true }));
  authClientStub.admin.impersonateUser.mockResolvedValue(ok({ status: true }));

  authClientStub.organization.checkRolePermission.mockReturnValue(false);
  authClientStub.organization.setActive.mockResolvedValue(ok({ id: 'org_1' }));
  authClientStub.organization.acceptInvitation.mockResolvedValue(
    ok({ invitation: {}, member: {} }),
  );
  authClientStub.organization.rejectInvitation.mockResolvedValue(
    ok({ invitation: {} }),
  );
  authClientStub.organization.getInvitation.mockResolvedValue(ok(null));

  authClientStub.organization.list.mockResolvedValue(ok([]));
  authClientStub.organization.create.mockResolvedValue(ok({ id: 'org_new' }));
  authClientStub.organization.update.mockResolvedValue(ok({ id: 'org_1' }));
  authClientStub.organization.checkSlug.mockResolvedValue(ok({ status: true }));
  authClientStub.organization.getFullOrganization.mockResolvedValue(ok(null));
  authClientStub.organization.inviteMember.mockResolvedValue(ok({ id: 'inv_1' }));
  authClientStub.organization.cancelInvitation.mockResolvedValue(
    ok({ id: 'inv_1' }),
  );
  authClientStub.organization.updateMemberRole.mockResolvedValue(
    ok({ id: 'member_1' }),
  );
  authClientStub.organization.removeMember.mockResolvedValue(
    ok({ member: { id: 'member_1' } }),
  );
}

/**
 * States what the reader is allowed to do globally, as a list of `resource:action`.
 */
export function allowGlobalPermissions(...granted: string[]): void {
  authClientStub.useSession.mockReturnValue({
    data: { user: { role: 'admin' } },
    isPending: false,
  } as never);
  authClientStub.admin.checkRolePermission.mockImplementation(
    (request) =>
      Object.entries(request.permissions).some(([resource, actions]) =>
        actions.some((action) => granted.includes(`${resource}:${action}`)),
      ),
  );
}

/**
 * States what the reader is allowed to do, as a list of `resource:action`.
 *
 * `checkRolePermission` is a pure local evaluation in production, so replacing
 * it lets a test say its premise directly — "this reader may remove members" —
 * instead of constructing a role and hoping the catalogue agrees. Shared
 * because three blocks need exactly this and three copies would drift.
 */
export function allowOrganizationPermissions(...granted: string[]): void {
  authClientStub.organization.checkRolePermission.mockImplementation(
    (request) =>
      Object.entries(request.permissions).some(([resource, actions]) =>
        actions.some((action) => granted.includes(`${resource}:${action}`)),
      ),
  );
}
