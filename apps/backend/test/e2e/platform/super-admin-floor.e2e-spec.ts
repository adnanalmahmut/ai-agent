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

/**
 * The platform cannot be left without a super administrator who can sign in.
 *
 * ## Why this suite is end to end
 *
 * The invariant has two enforcement points and only one of them is testable in
 * isolation. `super-admin-floor.spec.ts` covers the definition of "usable" and
 * the guard table; what cannot be asserted against a fake is the part that
 * actually makes the guarantee hold — a database trigger that takes an advisory
 * lock so two concurrent removals cannot both observe a survivor. That needs
 * two real transactions racing against a real PostgreSQL.
 *
 * ## Why the paths are enumerated
 *
 * Better Auth's admin plugin offers three routes that can make an account
 * unusable and this application offers two more, and the failure everybody
 * makes is protecting the one they were thinking about. Each is exercised
 * separately so a missing guard names itself.
 */

/**
 * A fixed, obviously-not-a-person id.
 *
 * The floor is a property of the whole `user` table, so this suite has to
 * control exactly which rows hold the role. Every other e2e suite creates its
 * own super administrators, and `maxWorkers: 1` is what keeps them from
 * overlapping with this one — but rows they left behind would still count, so
 * this suite counts and adjusts rather than assuming an empty table.
 */
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
  /** Not a super administrator. Ordinary account operations must be unaffected. */
  let ordinary: TestUser;
  /** Every pre-existing super administrator, parked for the duration. */
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

    /**
     * Anything else holding the role is demoted for the duration.
     *
     * The invariant is global, so a stray super administrator from another
     * suite would make "the last one" untrue and every refusal below would
     * become an accept. They are restored in `afterAll`.
     */
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

  /**
   * The population reset to exactly two usable super administrators.
   *
   * In this order, and the order is the point: restoring the two fixtures
   * first means the floor is satisfied before anything else is demoted. Doing
   * it the other way round — or cleaning up at the end of a test that promoted
   * somebody — asks the database to remove the last usable administrator, and
   * the trigger is entirely right to refuse. That is why no test here cleans up
   * after itself.
   */
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
    /** Leaves exactly one usable super administrator: `first`. */
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

    /**
     * The second door to both of the above. `update-user` writes arbitrary
     * user-schema fields, so guarding only the two named routes would leave a
     * third way to do the same thing.
     */
    it('refuses a demotion smuggled through update-user', async () => {
      await leaveOnlyFirst();

      const response = await as(harness, first).post(
        '/api/auth/admin/update-user',
        { userId: first.id, data: { role: 'user' } },
      );

      expect(response.status).not.toBe(200);
      expect(await usableCount()).toBe(1);
    });

    /**
     * Hard deletion is refused by the application, not by the trigger.
     *
     * The trigger fires on UPDATE only — see the migration for why — so this
     * asserts the other half of the layering: the guard hook refuses the route
     * before Better Auth reaches the database. It is belt and braces either
     * way, since `user:delete` is granted to no role and a repository invariant
     * test asserts nothing in the codebase calls the endpoint.
     */
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

    /**
     * The likeliest way this lockout actually happens: the last super
     * administrator deactivates their own account from the self-service route,
     * which names no user id at all.
     */
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

    /**
     * A second row holding the role is not a second administrator.
     *
     * This is the case a naive `count(role = 'super_admin')` gets wrong, and
     * the one that produces the lockout in practice — an operator demotes
     * themselves believing a colleague still holds the role, when that
     * colleague was banned months ago.
     */
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

    /** Promotion is not removal, and must stay reachable. */
    it('still allows appointing a replacement', async () => {
      await leaveOnlyFirst();

      const response = await as(harness, first).post(
        '/api/auth/admin/set-role',
        { userId: ordinary.id, role: 'super_admin' },
      );

      expect(response.status).toBe(200);
      expect(await usableCount()).toBe(2);

      // And now the previously-blocked demotion goes through.
      const demotion = await as(harness, first).post(
        '/api/auth/admin/set-role',
        { userId: first.id, role: 'user' },
      );

      expect(demotion.status).toBe(200);
    });
  });

  /**
   * Ordinary accounts are not touched by any of this.
   *
   * A guard that refused every user mutation would satisfy every assertion
   * above and break the product, so the negative case is asserted directly.
   */
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

  /**
   * The concurrency guarantee, which is the whole reason there is a trigger.
   *
   * Two administrators demoting each other at the same time each read "two
   * usable super administrators" — neither can see the other's uncommitted
   * write — so a check made in application code lets both proceed and the
   * platform ends with none. The trigger takes a transaction-scoped advisory
   * lock before it counts, so the second transaction blocks until the first
   * commits, then re-reads and raises.
   *
   * Driven through raw connections rather than HTTP: the point is to hold two
   * transactions open simultaneously with a controlled overlap, and two
   * supertest calls dispatched together do not reliably do that — the event
   * loop and the connection pool can finish one before the other starts.
   */
  it('cannot be emptied by two concurrent removals', async () => {
    const url = process.env.DATABASE_URL;
    const left = new Client({ connectionString: url });
    const right = new Client({ connectionString: url });

    await left.connect();
    await right.connect();

    try {
      await left.query('BEGIN');
      await right.query('BEGIN');

      /**
       * Left demotes the other administrator and holds its transaction open.
       *
       * Its trigger has already run and is holding the advisory lock, so the
       * count it saw — one survivor, `second` — is committed to but not yet
       * visible to anyone else.
       */
      await left.query(`UPDATE "user" SET role = 'user' WHERE id = $1`, [
        first.id,
      ]);

      /**
       * Right demotes the survivor. Deliberately not awaited: its trigger
       * blocks on the lock left is holding, and awaiting here would wait for a
       * commit that has not been issued.
       *
       * This is the whole race. Both transactions were started when two usable
       * administrators existed, so an application-level pre-check passed for
       * both — and the only thing that can stop them both from committing is
       * something that serializes at write time.
       */
      const contender = right.query(
        `UPDATE "user" SET role = 'user' WHERE id = $1`,
        [second.id],
      );

      await left.query('COMMIT');

      // Released, right proceeds, re-reads the committed state, and finds none.
      await expect(contender).rejects.toThrow(/super_admin_floor_violation/);

      await right.query('ROLLBACK');

      // The invariant held: exactly one usable super administrator survives.
      expect(await usableCount()).toBe(1);
    } finally {
      await left.query('ROLLBACK').catch(() => undefined);
      await right.query('ROLLBACK').catch(() => undefined);
      await left.end();
      await right.end();
    }
  }, 20_000);

  /**
   * The bootstrap path is untouched, and so is the recovery channel.
   *
   * `super-admin:create` inserts the first super administrator into a
   * population that has none, and `super-admin-cli.e2e-spec.ts` reaches that
   * state by deleting rows — so a trigger firing on INSERT or DELETE would
   * either block the command or block the only way to get back to the situation
   * it runs in. Asserted against the catalog rather than by trying to reach
   * zero, because reaching zero through an UPDATE is precisely what the rest of
   * this file proves is impossible.
   */
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
