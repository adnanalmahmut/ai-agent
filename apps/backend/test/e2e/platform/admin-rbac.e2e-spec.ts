import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Controller, Get } from '@nestjs/common';
import { UserHasPermission } from '@thallesp/nestjs-better-auth';
import request from 'supertest';

import {
  as,
  createHarness,
  createUser,
  errorBody,
  trySignIn,
  type Harness,
  type TestUser,
} from '../../support/auth-harness';

/**
 * Global RBAC and the account lifecycle that replaces hard deletion.
 *
 * Routes carry permissions, never role names — which is also what makes these
 * probes meaningful: each one asks a question of the access-control
 * definitions, and the answer is resolved from the database on every request.
 */
@Controller('probe/global')
class GlobalProbeController {
  @Get('list-users')
  @UserHasPermission({ permissions: { user: ['list'] } })
  listUsers() {
    return { ok: true };
  }

  @Get('set-role')
  @UserHasPermission({ permissions: { user: ['set-role'] } })
  setRole() {
    return { ok: true };
  }

  @Get('delete-user')
  @UserHasPermission({ permissions: { user: ['delete'] } })
  deleteUser() {
    return { ok: true };
  }

  @Get('deactivate')
  @UserHasPermission({ permissions: { accountLifecycle: ['deactivate'] } })
  deactivate() {
    return { ok: true };
  }
}

describe('Global RBAC and account lifecycle (e2e)', () => {
  let harness: Harness;
  let plainUser: TestUser;
  let admin: TestUser;
  let superAdmin: TestUser;

  beforeAll(async () => {
    harness = await createHarness({ controllers: [GlobalProbeController] });

    plainUser = await createUser(harness);
    admin = await createUser(harness, { role: 'admin' });
    superAdmin = await createUser(harness, { role: 'super_admin' });
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
  });

  describe('default role', () => {
    it('assigns "user" to a brand-new account', async () => {
      const created = await createUser(harness, { signIn: false });

      const row = await harness.prisma.user.findUnique({
        where: { id: created.id },
        select: { role: true },
      });

      expect(row?.role).toBe('user');
    });

    it('grants a plain user no administrative permission', async () => {
      await as(harness, plainUser).get('/probe/global/list-users').expect(403);
    });
  });

  describe('admin', () => {
    it('may list users', async () => {
      await as(harness, admin).get('/probe/global/list-users').expect(200);
    });

    it('may not set roles', async () => {
      await as(harness, admin).get('/probe/global/set-role').expect(403);
    });

    it('may not reach the account lifecycle', async () => {
      await as(harness, admin).get('/probe/global/deactivate').expect(403);
    });

    /**
     * The escalation attempt, end to end. An admin who could grant `admin`
     * could grant `super_admin`, because Better Auth's `setRole` validates
     * only that the target role exists.
     */
    it('cannot promote itself through Better Auth', async () => {
      const response = await as(harness, admin).post(
        '/api/auth/admin/set-role',
        { userId: admin.id, role: 'super_admin' },
      );

      expect(response.status).toBe(403);

      const row = await harness.prisma.user.findUnique({
        where: { id: admin.id },
        select: { role: true },
      });
      expect(row?.role).toBe('admin');
    });
  });

  describe('super_admin', () => {
    it('may set roles', async () => {
      await as(harness, superAdmin).get('/probe/global/set-role').expect(200);
    });

    it('may set a role through Better Auth', async () => {
      const target = await createUser(harness, { signIn: false });

      await as(harness, superAdmin)
        .post('/api/auth/admin/set-role', { userId: target.id, role: 'admin' })
        .expect(200);

      const row = await harness.prisma.user.findUnique({
        where: { id: target.id },
        select: { role: true },
      });
      expect(row?.role).toBe('admin');
    });

    /**
     * With no session cache, a role change is visible to the very next
     * permission check — the authorization decision is a database read.
     */
    it('a role change takes effect on the next request', async () => {
      const target = await createUser(harness);

      await as(harness, target).get('/probe/global/list-users').expect(403);

      await as(harness, superAdmin)
        .post('/api/auth/admin/set-role', { userId: target.id, role: 'admin' })
        .expect(200);

      await as(harness, target).get('/probe/global/list-users').expect(200);
    });
  });

  /**
   * The lifecycle policy, made executable.
   *
   * Better Auth's hard `remove-user` requires `user:["delete"]`, which no role
   * holds — so even the highest privilege in the system cannot destroy a row.
   * The reversible operation is available instead.
   */
  describe('hard user deletion is unavailable', () => {
    it('denies user:delete to super_admin', async () => {
      await as(harness, superAdmin)
        .get('/probe/global/delete-user')
        .expect(403);
    });

    it('refuses Better Auth remove-user for super_admin', async () => {
      const victim = await createUser(harness, { signIn: false });

      const response = await as(harness, superAdmin).post(
        '/api/auth/admin/remove-user',
        { userId: victim.id },
      );

      expect(response.status).toBe(403);

      const row = await harness.prisma.user.findUnique({
        where: { id: victim.id },
      });
      expect(row).not.toBeNull();
    });

    it('refuses Better Auth remove-user for admin', async () => {
      const victim = await createUser(harness, { signIn: false });

      const response = await as(harness, admin).post(
        '/api/auth/admin/remove-user',
        { userId: victim.id },
      );

      expect(response.status).toBe(403);
    });

    it('offers the reversible operation to super_admin instead', async () => {
      await as(harness, superAdmin).get('/probe/global/deactivate').expect(200);
    });
  });

  describe('account deactivation', () => {
    it('preserves the row and its provider accounts', async () => {
      const victim = await createUser(harness);

      await as(harness, superAdmin)
        .post(`/admin/users/${victim.id}/deactivate`, { reason: 'abuse' })
        .expect(201);

      const row = await harness.prisma.user.findUnique({
        where: { id: victim.id },
        select: {
          deletedAt: true,
          deletedByUserId: true,
          deletionReason: true,
        },
      });

      expect(row?.deletedAt).toBeInstanceOf(Date);
      expect(row?.deletedByUserId).toBe(superAdmin.id);
      expect(row?.deletionReason).toBe('abuse');

      const accounts = await harness.prisma.account.count({
        where: { userId: victim.id },
      });
      expect(accounts).toBeGreaterThan(0);
    });

    it('destroys every session immediately', async () => {
      const victim = await createUser(harness);

      await as(harness, superAdmin)
        .post(`/admin/users/${victim.id}/deactivate`)
        .expect(201);

      const sessions = await harness.prisma.session.count({
        where: { userId: victim.id },
      });
      expect(sessions).toBe(0);
    });

    it('rejects the next request from an existing session', async () => {
      const victim = await createUser(harness);

      await as(harness, victim).get('/probe/global/list-users').expect(403);

      await as(harness, superAdmin)
        .post(`/admin/users/${victim.id}/deactivate`)
        .expect(201);

      // 401, not 403: the session is gone, so there is nothing to authorize.
      await as(harness, victim).get('/probe/global/list-users').expect(401);
    });

    it('refuses a new email/password sign-in', async () => {
      const victim = await createUser(harness);

      await as(harness, superAdmin)
        .post(`/admin/users/${victim.id}/deactivate`)
        .expect(201);

      const response = await trySignIn(harness, victim.email);

      expect(response.status).toBe(403);
      expect(JSON.stringify(response.body)).toContain('ACCOUNT_DEACTIVATED');
    });

    /**
     * Enforced at session creation rather than per sign-in route, which is
     * what makes it hold for Google and for any provider added later: every
     * path ends in `databaseHooks.session.create.before`.
     */
    it('blocks session creation regardless of the sign-in path', async () => {
      const victim = await createUser(harness);

      await as(harness, superAdmin)
        .post(`/admin/users/${victim.id}/deactivate`)
        .expect(201);

      const before = await harness.prisma.session.count({
        where: { userId: victim.id },
      });
      await trySignIn(harness, victim.email);
      const after = await harness.prisma.session.count({
        where: { userId: victim.id },
      });

      expect(after).toBe(before);
      expect(after).toBe(0);
    });

    it('is idempotent with a stable error code', async () => {
      const victim = await createUser(harness);

      await as(harness, superAdmin)
        .post(`/admin/users/${victim.id}/deactivate`)
        .expect(201);

      const response = await as(harness, superAdmin).post(
        `/admin/users/${victim.id}/deactivate`,
      );

      expect(response.status).toBe(409);
      expect(errorBody(response).errorCode).toBe('ACCOUNT_ALREADY_DEACTIVATED');
    });

    it('allows a regular user to deactivate their own account via /user/account/deactivate', async () => {
      const userToDeactivate = await createUser(harness);

      await as(harness, userToDeactivate)
        .post('/user/account/deactivate', { reason: 'self request' })
        .expect(201);

      const row = await harness.prisma.user.findUnique({
        where: { id: userToDeactivate.id },
        select: {
          deletedAt: true,
          deletedByUserId: true,
          deletionReason: true,
        },
      });

      expect(row?.deletedAt).toBeInstanceOf(Date);
      expect(row?.deletedByUserId).toBe(userToDeactivate.id);
      expect(row?.deletionReason).toBe('self request');

      const sessions = await harness.prisma.session.count({
        where: { userId: userToDeactivate.id },
      });
      expect(sessions).toBe(0);
    });

    it('refuses admin from calling /admin/users/:userId/deactivate', async () => {
      const victim = await createUser(harness);

      await as(harness, admin)
        .post(`/admin/users/${victim.id}/deactivate`)
        .expect(403);
    });

    it('reports an unknown account with a stable code', async () => {
      const response = await as(harness, superAdmin).post(
        '/admin/users/00000000-0000-0000-0000-000000000000/deactivate',
      );

      expect(response.status).toBe(404);
      expect(errorBody(response).errorCode).toBe('USER_NOT_FOUND');
    });

    it('is denied to an admin', async () => {
      const victim = await createUser(harness, { signIn: false });

      await as(harness, admin)
        .post(`/admin/users/${victim.id}/deactivate`)
        .expect(403);
    });

    it('is denied to a plain user', async () => {
      const victim = await createUser(harness, { signIn: false });

      await as(harness, plainUser)
        .post(`/admin/users/${victim.id}/deactivate`)
        .expect(403);
    });
  });

  describe('account restore', () => {
    it('lets the account sign in again', async () => {
      const victim = await createUser(harness);

      await as(harness, superAdmin)
        .post(`/admin/users/${victim.id}/deactivate`)
        .expect(201);
      await expect(trySignIn(harness, victim.email)).resolves.toMatchObject({
        status: 403,
      });

      await as(harness, superAdmin)
        .post(`/admin/users/${victim.id}/restore`)
        .expect(201);

      const response = await trySignIn(harness, victim.email);
      expect(response.status).toBe(200);
    });

    it('keeps the same user id and its accounts', async () => {
      const victim = await createUser(harness);
      const accountsBefore = await harness.prisma.account.count({
        where: { userId: victim.id },
      });

      await as(harness, superAdmin)
        .post(`/admin/users/${victim.id}/deactivate`)
        .expect(201);
      await as(harness, superAdmin)
        .post(`/admin/users/${victim.id}/restore`)
        .expect(201);

      const row = await harness.prisma.user.findUnique({
        where: { id: victim.id },
        select: { id: true, deletedAt: true },
      });
      expect(row?.id).toBe(victim.id);
      expect(row?.deletedAt).toBeNull();

      await expect(
        harness.prisma.account.count({ where: { userId: victim.id } }),
      ).resolves.toBe(accountsBefore);
    });

    it('does not create a session', async () => {
      const victim = await createUser(harness);

      await as(harness, superAdmin)
        .post(`/admin/users/${victim.id}/deactivate`)
        .expect(201);
      await as(harness, superAdmin)
        .post(`/admin/users/${victim.id}/restore`)
        .expect(201);

      await expect(
        harness.prisma.session.count({ where: { userId: victim.id } }),
      ).resolves.toBe(0);
    });

    it('is idempotent with a stable error code', async () => {
      const target = await createUser(harness, { signIn: false });

      const response = await as(harness, superAdmin).post(
        `/admin/users/${target.id}/restore`,
      );

      expect(response.status).toBe(409);
      expect(errorBody(response).errorCode).toBe('ACCOUNT_NOT_DEACTIVATED');
    });

    it('is denied to an admin', async () => {
      const victim = await createUser(harness, { signIn: false });

      await as(harness, superAdmin)
        .post(`/admin/users/${victim.id}/deactivate`)
        .expect(201);
      await as(harness, admin)
        .post(`/admin/users/${victim.id}/restore`)
        .expect(403);
    });
  });

  /**
   * A ban and a deactivation are different states with different authorities.
   * Overloading `banned` to mean "deleted" would make each one silently undo
   * the other.
   */
  describe('ban and deactivation are independent', () => {
    it('deactivating does not set the ban flag', async () => {
      const victim = await createUser(harness);

      await as(harness, superAdmin)
        .post(`/admin/users/${victim.id}/deactivate`)
        .expect(201);

      const row = await harness.prisma.user.findUnique({
        where: { id: victim.id },
        select: { banned: true, deletedAt: true },
      });

      expect(row?.banned).toBe(false);
      expect(row?.deletedAt).not.toBeNull();
    });

    it('restoring leaves an independent ban in place', async () => {
      const victim = await createUser(harness);

      await as(harness, admin)
        .post('/api/auth/admin/ban-user', {
          userId: victim.id,
          banReason: 'independent',
        })
        .expect(200);

      await as(harness, superAdmin)
        .post(`/admin/users/${victim.id}/deactivate`)
        .expect(201);
      await as(harness, superAdmin)
        .post(`/admin/users/${victim.id}/restore`)
        .expect(201);

      const row = await harness.prisma.user.findUnique({
        where: { id: victim.id },
        select: { banned: true, banReason: true, deletedAt: true },
      });

      expect(row?.deletedAt).toBeNull();
      expect(row?.banned).toBe(true);
      expect(row?.banReason).toBe('independent');
    });

    it('still refuses sign-in for a restored but banned account', async () => {
      const victim = await createUser(harness);

      await as(harness, admin)
        .post('/api/auth/admin/ban-user', { userId: victim.id })
        .expect(200);
      await as(harness, superAdmin)
        .post(`/admin/users/${victim.id}/deactivate`)
        .expect(201);
      await as(harness, superAdmin)
        .post(`/admin/users/${victim.id}/restore`)
        .expect(201);

      const response = await trySignIn(harness, victim.email);
      expect(response.status).toBe(403);
    });
  });

  describe('session revocation without a cache', () => {
    it('rejects the next request after the session is revoked', async () => {
      const target = await createUser(harness, { role: 'admin' });

      await as(harness, target).get('/probe/global/list-users').expect(200);

      await harness.prisma.session.deleteMany({ where: { userId: target.id } });

      await as(harness, target).get('/probe/global/list-users').expect(401);
    });

    it('sets no session_data cache cookie on sign-in', async () => {
      const target = await createUser(harness, { signIn: false });
      await harness.prisma.user.update({
        where: { id: target.id },
        data: { emailVerified: true },
      });

      const response = await request(harness.server)
        .post('/api/auth/sign-in/email')
        .send({ email: target.email, password: target.password });

      const header = response.headers['set-cookie'];
      const cookies = Array.isArray(header) ? header : header ? [header] : [];

      expect(cookies.join(';')).not.toContain('session_data');
    });
  });

  describe('localized failures', () => {
    it('localizes a permission denial in English', async () => {
      const response = await as(harness, plainUser)
        .get('/probe/global/list-users')
        .set('X-App-Locale', 'en');

      expect(response.status).toBe(403);
      expect(errorBody(response).errorCode).toBe('FORBIDDEN');
      expect(errorBody(response).message).toBe(
        'You do not have permission to perform this action',
      );
    });

    it('localizes a permission denial in Arabic', async () => {
      const response = await as(harness, plainUser)
        .get('/probe/global/list-users')
        .set('X-App-Locale', 'ar');

      expect(errorBody(response).message).toBe(
        'لا تملك صلاحية تنفيذ هذا الإجراء',
      );
    });

    it('localizes a lifecycle conflict', async () => {
      const target = await createUser(harness, { signIn: false });

      const response = await as(harness, superAdmin)
        .post(`/admin/users/${target.id}/restore`)
        .set('X-App-Locale', 'en');

      expect(errorBody(response).message).toBe(
        'This account is active and does not need to be restored',
      );
    });
  });
});
