import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import { Client } from 'pg';

import {
  as,
  createHarness,
  createUser,
  errorBody,
  type Harness,
  type TestUser,
} from '../../support/auth-harness';

const isUsable = (row: {
  role: string | null;
  banned: boolean | null;
  deletedAt: Date | null;
}) =>
  (row.role ?? '')
    .split(',')
    .map((name) => name.trim())
    .includes('super_admin') &&
  row.banned !== true &&
  row.deletedAt === null;

describe('the last usable super administrator', () => {
  let harness: Harness;
  let first: TestUser;
  let second: TestUser;
  let ordinary: TestUser;
  let parked: string[] = [];

  const usableCount = async () => {
    const rows = await harness.prisma.user.findMany({
      where: { role: { contains: 'super_admin' } },
      select: { role: true, banned: true, deletedAt: true },
    });

    return rows.filter(isUsable).length;
  };

  beforeAll(async () => {
    harness = await createHarness();

    first = await createUser(harness, { role: 'super_admin' });
    second = await createUser(harness, { role: 'super_admin' });
    ordinary = await createUser(harness);

    const others = await harness.prisma.user.findMany({
      where: {
        role: { contains: 'super_admin' },
        id: { notIn: [first.id, second.id] },
      },
      select: { id: true },
    });

    parked = others.map((row) => row.id);

    if (parked.length > 0) {
      await harness.prisma.user.updateMany({
        where: { id: { in: parked } },
        data: { role: 'user' },
      });
    }
  });

  afterAll(async () => {
    if (parked.length > 0) {
      await harness.prisma.user.updateMany({
        where: { id: { in: parked } },
        data: { role: 'super_admin' },
      });
    }

    await harness.close();
  });

  beforeEach(async () => {
    await harness.prisma.user.updateMany({
      where: { id: { in: [first.id, second.id] } },
      data: { role: 'super_admin', banned: false, deletedAt: null },
    });

    await harness.prisma.user.updateMany({
      where: {
        role: { contains: 'super_admin' },
        id: { notIn: [first.id, second.id] },
      },
      data: { role: 'user' },
    });
  });

  describe('while another usable super administrator exists', () => {
    it('allows a demotion through Better Auth', async () => {
      const response = await as(harness, first).post(
        '/api/auth/admin/set-role',
        { userId: second.id, role: 'user' },
      );

      expect(response.status).toBe(200);
      expect(await usableCount()).toBe(1);
    });

    it('allows a ban through Better Auth', async () => {
      const response = await as(harness, first).post(
        '/api/auth/admin/ban-user',
        { userId: second.id },
      );

      expect(response.status).toBe(200);
      expect(await usableCount()).toBe(1);
    });

    it('allows a deactivation through the application route', async () => {
      const response = await as(harness, first).post(
        `/admin/users/${second.id}/deactivate`,
        {},
      );

      expect(response.status).toBe(201);
      expect(await usableCount()).toBe(1);
    });
  });

  describe('when it is the last one', () => {
    const leaveOnlyFirst = () =>
      harness.prisma.user.update({
        where: { id: second.id },
        data: { role: 'user' },
      });

    it('refuses a demotion through Better Auth', async () => {
      await leaveOnlyFirst();

      const response = await as(harness, first).post(
        '/api/auth/admin/set-role',
        { userId: first.id, role: 'user' },
      );

      expect(response.status).toBe(409);
      expect(await usableCount()).toBe(1);
    });

    it('refuses a ban through Better Auth', async () => {
      await leaveOnlyFirst();

      const response = await as(harness, first).post(
        '/api/auth/admin/ban-user',
        { userId: first.id },
      );

      expect(response.status).toBe(409);
      expect(await usableCount()).toBe(1);
    });

    it('refuses a demotion smuggled through update-user', async () => {
      await leaveOnlyFirst();

      const response = await as(harness, first).post(
        '/api/auth/admin/update-user',
        { userId: first.id, data: { role: 'user' } },
      );

      expect(response.status).not.toBe(200);
      expect(await usableCount()).toBe(1);
    });

    it('refuses hard deletion through Better Auth', async () => {
      await leaveOnlyFirst();

      const response = await as(harness, first).post(
        '/api/auth/admin/remove-user',
        { userId: first.id },
      );

      expect(response.status).not.toBe(200);
      expect(await usableCount()).toBe(1);
    });

    it('refuses a deactivation through the application route', async () => {
      await leaveOnlyFirst();

      const response = await as(harness, first).post(
        `/admin/users/${first.id}/deactivate`,
        {},
      );

      expect(response.status).toBe(409);
      expect(errorBody(response).errorCode).toBe('LAST_SUPER_ADMIN');
      expect(await usableCount()).toBe(1);
    });

    it('refuses self-deactivation through the self-service route', async () => {
      await leaveOnlyFirst();

      const response = await as(harness, first).post(
        '/user/account/deactivate',
        {},
      );

      expect(response.status).toBe(409);
      expect(errorBody(response).errorCode).toBe('LAST_SUPER_ADMIN');
      expect(await usableCount()).toBe(1);
    });

    it.each([
      ['banned', { banned: true }],
      ['deactivated', { deletedAt: new Date() }],
    ])('counts a %s colleague as nobody', async (unusedName, state) => {
      await harness.prisma.user.update({
        where: { id: second.id },
        data: state,
      });

      const response = await as(harness, first).post(
        `/admin/users/${first.id}/deactivate`,
        {},
      );

      expect(response.status).toBe(409);
      expect(await usableCount()).toBe(1);
    });

    it('still allows appointing a replacement', async () => {
      await leaveOnlyFirst();

      const response = await as(harness, first).post(
        '/api/auth/admin/set-role',
        { userId: ordinary.id, role: 'super_admin' },
      );

      expect(response.status).toBe(200);
      expect(await usableCount()).toBe(2);

      const demotion = await as(harness, first).post(
        '/api/auth/admin/set-role',
        { userId: first.id, role: 'user' },
      );

      expect(demotion.status).toBe(200);
    });
  });

  it('leaves ordinary account operations alone', async () => {
    const target = await createUser(harness);

    expect(
      (
        await as(harness, first).post('/api/auth/admin/ban-user', {
          userId: target.id,
        })
      ).status,
    ).toBe(200);

    expect(
      (
        await as(harness, first).post(
          `/admin/users/${target.id}/deactivate`,
          {},
        )
      ).status,
    ).toBe(201);
  });

  it('cannot be emptied by two concurrent removals', async () => {
    const url = process.env.DATABASE_URL;
    const left = new Client({ connectionString: url });
    const right = new Client({ connectionString: url });

    await left.connect();
    await right.connect();

    try {
      await left.query('BEGIN');
      await right.query('BEGIN');

      await left.query(`UPDATE "user" SET role = 'user' WHERE id = $1`, [
        first.id,
      ]);

      const contender = right.query(
        `UPDATE "user" SET role = 'user' WHERE id = $1`,
        [second.id],
      );

      await left.query('COMMIT');

      await expect(contender).rejects.toThrow(/super_admin_floor_violation/);

      await right.query('ROLLBACK');

      expect(await usableCount()).toBe(1);
    } finally {
      await left.query('ROLLBACK').catch(() => undefined);
      await right.query('ROLLBACK').catch(() => undefined);
      await left.end();
      await right.end();
    }
  }, 20_000);

  it('fires on updates only, leaving insertion and deletion alone', async () => {
    const events = await harness.prisma.$queryRawUnsafe<
      { event_manipulation: string }[]
    >(
      `SELECT event_manipulation FROM information_schema.triggers
       WHERE trigger_name = 'enforce_super_admin_floor_trigger'`,
    );

    expect(events.map((row) => row.event_manipulation).sort()).toEqual([
      'UPDATE',
    ]);
  });
});
