import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';

import { CONTENT_IDEA_AGENT_ID } from '../../src/agents';
import {
  FeatureFlagService,
  RuntimeSettingService,
} from '../../src/control-plane';
import {
  as,
  createHarness,
  createUser,
  errorBody,
  type Harness,
  type TestUser,
} from '../support/auth-harness';

/**
 * The content-idea business surface, against the real application.
 *
 * No provider is reached. Requesting ideas accepts work and returns an
 * operation; the run is executed by the worker, which is a different process
 * and a different suite. What is only true end to end is everything around
 * that acceptance: that both feature flags gate it, that the operator's
 * in-flight ceiling is enforced, that the guard answers for the organization
 * in the path, that an idempotency key is bound to the body it arrived with,
 * and that one organization cannot read another's operation.
 *
 * A budget note for whoever adds the next test here. The endpoint is metered
 * at twenty requests per user per five minutes, which is a real production
 * bound on a billed operation and is not raised to fit a suite. This file is
 * already close to it for `owner`, so a new block that posts more than a
 * couple of times should introduce its own member — `spender` and
 * `secondSpender` exist for exactly that, and which session sends a request is
 * not part of what the organization-scoped blocks assert.
 */

type Operation = {
  id: string;
  status: string;
  output: unknown;
  completedAt: string | null;
};

const dataOf = <T>(body: unknown): T => (body as { data: T }).data;

/** Both gates acceptance checks, coarse first. */
const ENABLED_FLAGS = ['agents.enabled', 'content_ideas.enabled'] as const;

const REQUEST = {
  topic: 'Electric kettles',
  audience: 'Home cooks',
  count: 3,
};

describe('content ideas', () => {
  let harness: Harness;
  let owner: TestUser;
  let orgAdmin: TestUser;
  let member: TestUser;
  /**
   * Two more admins of the same organization, so no single user runs into the
   * controller's per-user budget of 20 requests per five minutes.
   *
   * That budget is a real production bound on a billed endpoint and is not
   * loosened to fit a test suite. It does mean a file that grows past twenty
   * requests by one user has to spread them, which is what these are for —
   * and the blocks that use them are about the *organization's* ceiling, so
   * whose session sends the request is not part of what they assert.
   */
  let spender: TestUser;
  let secondSpender: TestUser;
  let outsider: TestUser;
  let superAdmin: TestUser;
  let organizationId: string;
  let otherOrganizationId: string;

  const base = (id = organizationId) =>
    `/organizations/${encodeURIComponent(id)}/content-ideas`;

  const createOrganization = async (user: TestUser, name: string) => {
    const response = await as(harness, user).post(
      '/api/auth/organization/create',
      { name, slug: `${name}-${Date.now().toString(36)}` },
    );

    expect(response.status).toBe(200);

    return (response.body as { id: string }).id;
  };

  const addMember = async (
    invitee: TestUser,
    role: string,
    target: string,
    inviter: TestUser,
  ) => {
    const invite = await as(harness, inviter).post(
      '/api/auth/organization/invite-member',
      { email: invitee.email, role, organizationId: target },
    );
    expect(invite.status).toBe(200);

    const accept = await as(harness, invitee).post(
      '/api/auth/organization/accept-invitation',
      { invitationId: (invite.body as { id: string }).id },
    );
    expect(accept.status).toBe(200);
  };

  /** Every request needs a key; tests that do not care about it get a fresh one. */
  let keySeed = 0;
  const freshKey = () => `e2e-key-${(keySeed += 1)}-${Date.now().toString(36)}`;

  const request = (
    user: TestUser,
    body: unknown = REQUEST,
    key = freshKey(),
    organization = organizationId,
  ) =>
    as(harness, user)
      .post(base(organization), body)
      .set('idempotency-key', key);

  beforeAll(async () => {
    harness = await createHarness();

    owner = await createUser(harness);
    orgAdmin = await createUser(harness);
    member = await createUser(harness);
    spender = await createUser(harness);
    secondSpender = await createUser(harness);
    outsider = await createUser(harness);
    superAdmin = await createUser(harness, { role: 'super_admin' });

    organizationId = await createOrganization(owner, 'ideas-acme');
    otherOrganizationId = await createOrganization(outsider, 'ideas-other');

    await addMember(orgAdmin, 'admin', organizationId, owner);
    await addMember(member, 'member', organizationId, owner);
    await addMember(spender, 'admin', organizationId, owner);
    await addMember(secondSpender, 'admin', organizationId, owner);

    /**
     * Enabled per organization, not platform-wide.
     *
     * A platform override is global state in a database every suite shares:
     * `control-plane.e2e-spec.ts` counts that table with no predicate and
     * asserts it is empty, and clears it unscoped for exactly the reason that
     * an interrupted run must not leave a flag on for the next suite. Scoping
     * these to the two organizations this file owns means the isolation is a
     * property of the rows rather than of `maxWorkers: 1` and an `afterAll`
     * that ran.
     *
     * Both flags, because acceptance now checks the coarse agent switch as
     * well as the feature's own.
     */
    for (const key of ENABLED_FLAGS) {
      for (const target of [organizationId, otherOrganizationId]) {
        await harness.app.get(FeatureFlagService).setOrganizationOverride({
          key,
          organizationId: target,
          enabled: true,
          actorUserId: superAdmin.id,
        });
      }
    }
  });

  afterAll(async () => {
    for (const key of ENABLED_FLAGS) {
      for (const target of [organizationId, otherOrganizationId]) {
        await harness.app.get(FeatureFlagService).clearOrganizationOverride({
          key,
          organizationId: target,
        });
      }
    }

    await clearRuns();
    await harness.close();
  });

  beforeEach(clearRuns);

  /**
   * The runs and the dispatch intents they committed.
   *
   * Every accepted request writes an outbox row keyed on the run id in the
   * same transaction, so deleting only the runs leaves PENDING intents
   * pointing at rows that no longer exist — accumulating across runs in a
   * database every suite shares, and waiting for the first suite that starts
   * a real relay without wiping the table first.
   */
  async function clearRuns() {
    const runs = await harness.prisma.agentRun.findMany({
      where: { organizationId: { in: [organizationId, otherOrganizationId] } },
      select: { id: true },
    });

    if (runs.length > 0) {
      await harness.prisma.outboxEvent.deleteMany({
        where: { dedupeKey: { in: runs.map((run) => run.id) } },
      });
    }

    await harness.prisma.agentRun.deleteMany({
      where: { organizationId: { in: [organizationId, otherOrganizationId] } },
    });
  }

  describe('accepting a request', () => {
    it('queues a run and answers with the operation, not the result', async () => {
      const response = await request(owner);

      expect(response.status).toBe(201);

      const operation = dataOf<Operation>(response.body);
      expect(operation.status).toBe('QUEUED');
      // The provider has not been called and must not appear to have been.
      expect(operation.output).toBeNull();
      expect(operation.completedAt).toBeNull();

      const run = await harness.prisma.agentRun.findUniqueOrThrow({
        where: { id: operation.id },
      });
      expect(run.agentId).toBe(CONTENT_IDEA_AGENT_ID);
      expect(run.agentVersion).toBe(1);
      expect(run.organizationId).toBe(organizationId);
      expect(run.createdByUserId).toBe(owner.id);
    });

    /**
     * The accepted work and its delivery intent commit together. Without the
     * outbox row the run would sit `QUEUED` forever with nothing to notice it.
     */
    it('commits the queue intent with the run', async () => {
      const operation = dataOf<Operation>((await request(owner)).body);

      const events = await harness.prisma.outboxEvent.count({
        where: {
          type: 'agent-run.queued',
          payload: { path: ['runId'], equals: operation.id },
        },
      });

      expect(events).toBe(1);
    });

    it('stores the validated input rather than the raw body', async () => {
      const operation = dataOf<Operation>(
        (await request(owner, { topic: '  Kettles  ', audience: 'Cooks' }))
          .body,
      );

      const run = await harness.prisma.agentRun.findUniqueOrThrow({
        where: { id: operation.id },
      });

      // Trimmed, and the default applied — the run executes what was parsed.
      expect(run.input).toEqual({
        topic: 'Kettles',
        audience: 'Cooks',
        count: 5,
      });
    });

    it.each([
      ['no topic', { audience: 'Home cooks' }],
      ['a count beyond the contract', { ...REQUEST, count: 99 }],
      ['an unrecognized field', { ...REQUEST, model: 'gpt-5' }],
    ])('refuses %s', async (_name, body) => {
      const response = await request(owner, body);

      expect(response.status).toBe(400);
    });
  });

  describe('the idempotency key', () => {
    it('is required', async () => {
      const response = await as(harness, owner).post(base(), REQUEST);

      expect(response.status).toBe(400);
      expect(errorBody(response).errorCode).toBe('VALIDATION_ERROR');
    });

    it('returns the same operation for an honest retry', async () => {
      const key = freshKey();

      const first = dataOf<Operation>(
        (await request(owner, REQUEST, key)).body,
      );
      const second = dataOf<Operation>(
        (await request(owner, REQUEST, key)).body,
      );

      expect(second.id).toBe(first.id);

      const runs = await harness.prisma.agentRun.count({
        where: { organizationId },
      });
      expect(runs).toBe(1);
    });

    /**
     * The key is bound to the body it was sent with.
     *
     * `AgentRunService` returns the stored run for a key it has seen and does
     * not compare the rest of the request — correct for a retry, wrong for
     * reuse. A client that recycled one key across two different asks would
     * otherwise be handed the first answer for the second question, which is
     * worse than an error because it looks like a result.
     */
    it('does not hand back the first answer when the request changed', async () => {
      const key = freshKey();

      const first = dataOf<Operation>(
        (await request(owner, REQUEST, key)).body,
      );
      const second = dataOf<Operation>(
        (await request(owner, { ...REQUEST, topic: 'Cast iron pans' }, key))
          .body,
      );

      expect(second.id).not.toBe(first.id);
    });

    /**
     * The other half of the key, which the body cases do not reach.
     *
     * Dropping the caller's key and storing only the digest passes both tests
     * above — a retry still finds its run, a changed body still gets a new one
     * — while two members asking the same question at the same time collapse
     * into one run, and the second one is handed the first one's operation.
     */
    it('keeps two callers asking the same question apart', async () => {
      const first = dataOf<Operation>(
        (await request(spender, REQUEST, freshKey())).body,
      );
      const second = dataOf<Operation>(
        (await request(secondSpender, REQUEST, freshKey())).body,
      );

      expect(second.id).not.toBe(first.id);
    });

    it('treats a differently ordered body as the same request', async () => {
      const key = freshKey();

      const first = dataOf<Operation>(
        (
          await request(
            owner,
            { topic: 'Kettles', audience: 'Cooks', count: 3 },
            key,
          )
        ).body,
      );
      const second = dataOf<Operation>(
        (
          await request(
            owner,
            { count: 3, audience: 'Cooks', topic: 'Kettles' },
            key,
          )
        ).body,
      );

      expect(second.id).toBe(first.id);
    });
  });

  describe('authorization', () => {
    it('lets an organization admin request ideas', async () => {
      expect((await request(orgAdmin)).status).toBe(201);
    });

    /**
     * Creating spends the platform's provider credential; reading does not.
     * A member sees the team's results and cannot start new work.
     */
    it('lets a plain member read but not request', async () => {
      const operation = dataOf<Operation>((await request(owner)).body);

      expect((await request(member)).status).toBe(403);

      const read = await as(harness, member).get(`${base()}/${operation.id}`);
      expect(read.status).toBe(200);
    });

    it('refuses a non-member entirely', async () => {
      const operation = dataOf<Operation>((await request(owner)).body);

      expect((await request(outsider)).status).toBe(404);
      expect(
        (await as(harness, outsider).get(`${base()}/${operation.id}`)).status,
      ).toBe(404);
    });

    it('refuses a platform super administrator who is not a member', async () => {
      expect((await request(superAdmin)).status).toBe(404);
    });

    /**
     * The failure that only appears for someone in two organizations: the
     * decorator this controller deliberately does not use would authorize
     * against whichever organization the session has selected.
     */
    it('answers for the organization in the path, not the one selected', async () => {
      await as(harness, owner).post('/api/auth/organization/set-active', {
        organizationId,
      });

      const response = await request(
        owner,
        REQUEST,
        freshKey(),
        otherOrganizationId,
      );

      expect(response.status).toBe(404);
    });

    /**
     * Authorization runs before the body is parsed, so an unauthorized caller
     * cannot learn the request shape from a validation error.
     */
    it('refuses an outsider before validating their body', async () => {
      const response = await as(harness, outsider)
        .post(base(), { nonsense: true })
        .set('idempotency-key', freshKey());

      expect(response.status).toBe(404);
    });
  });

  describe('reading an operation', () => {
    it('does not serve one organization operation to another', async () => {
      const operation = dataOf<Operation>((await request(owner)).body);

      const response = await as(harness, outsider).get(
        `${base(otherOrganizationId)}/${operation.id}`,
      );

      expect(response.status).toBe(404);
    });

    it('answers 404 for an operation that does not exist', async () => {
      const response = await as(harness, owner).get(
        `${base()}/00000000-0000-0000-0000-000000000000`,
      );

      expect(response.status).toBe(404);
    });

    /**
     * A run produced by a different agent is not a content-idea operation, and
     * saying so differently would make this endpoint a way to enumerate runs.
     */
    it('answers 404 for a run belonging to another agent', async () => {
      const foreign = await harness.prisma.agentRun.create({
        data: {
          agentId: 'some-other-agent',
          agentVersion: 1,
          runtime: 'mastra',
          organizationId,
          input: {},
          idempotencyKey: `foreign-${Date.now()}`,
        },
      });

      const response = await as(harness, owner).get(`${base()}/${foreign.id}`);

      expect(response.status).toBe(404);
    });

    it('withholds the output until the run has succeeded', async () => {
      const operation = dataOf<Operation>((await request(owner)).body);

      await harness.prisma.agentRun.update({
        where: { id: operation.id },
        data: { status: 'FAILED', output: { ideas: [] } },
      });

      const failed = dataOf<Operation>(
        (await as(harness, owner).get(`${base()}/${operation.id}`)).body,
      );

      expect(failed.status).toBe('FAILED');
      expect(failed.output).toBeNull();
    });

    it('returns the output once the run has succeeded', async () => {
      const operation = dataOf<Operation>((await request(owner)).body);
      const output = {
        ideas: [{ title: 'A title', angle: 'An angle.', format: 'post' }],
        sources: ['brand'],
      };

      await harness.prisma.agentRun.update({
        where: { id: operation.id },
        data: { status: 'SUCCEEDED', output },
      });

      const succeeded = dataOf<Operation>(
        (await as(harness, owner).get(`${base()}/${operation.id}`)).body,
      );

      expect(succeeded.output).toEqual(output);
    });
  });

  describe('feature gating', () => {
    /**
     * Sets a flag for the duration of one test and puts it back.
     *
     * Restores to `enabled: true` rather than clearing, because this suite's
     * organizations are enabled by an override of their own — clearing would
     * drop them to the platform default, which is off, and every test after
     * this one would fail for a reason belonging to this one.
     */
    const withFlag = async (
      key: (typeof ENABLED_FLAGS)[number],
      enabled: boolean,
      body: () => Promise<void>,
      target = organizationId,
    ) => {
      const flags = harness.app.get(FeatureFlagService);

      await flags.setOrganizationOverride({
        key,
        organizationId: target,
        enabled,
        actorUserId: superAdmin.id,
      });

      try {
        await body();
      } finally {
        await flags.setOrganizationOverride({
          key,
          organizationId: target,
          enabled: true,
          actorUserId: superAdmin.id,
        });
      }
    };

    it('refuses new requests and still serves existing ones when disabled', async () => {
      const operation = dataOf<Operation>((await request(orgAdmin)).body);

      await withFlag('content_ideas.enabled', false, async () => {
        const refused = await request(orgAdmin);
        expect(refused.status).toBe(403);
        expect(errorBody(refused).errorCode).toBe('FEATURE_DISABLED');

        // Turning the feature off stops new work; it does not retract answers
        // the organization already has.
        const read = await as(harness, orgAdmin).get(
          `${base()}/${operation.id}`,
        );
        expect(read.status).toBe(200);
      });
    });

    /**
     * The coarse switch, which until this feature existed gated nothing.
     *
     * It is the one an operator reaches for to stop every agent at once. If
     * acceptance checked only the per-feature flag, switching agents off would
     * change nothing observable and the real control would be a flag named
     * after one feature.
     */
    it('refuses when the platform-wide agent switch is off', async () => {
      await withFlag('agents.enabled', false, async () => {
        const refused = await request(orgAdmin);

        expect(refused.status).toBe(403);
        expect(errorBody(refused).errorCode).toBe('FEATURE_DISABLED');
      });
    });

    it('leaves another organization unaffected', async () => {
      await withFlag('content_ideas.enabled', false, async () => {
        const response = await request(
          outsider,
          REQUEST,
          freshKey(),
          otherOrganizationId,
        );

        expect(response.status).toBe(201);
      });
    });
  });

  /**
   * The operator's ceiling on concurrent spend.
   *
   * `agents.max_concurrent_runs_per_organization` had been offered to
   * operators since the control plane landed and enforced by nothing. The
   * per-user rate limit does not substitute for it: that bounds one member,
   * and the bill is the organization's.
   */
  describe('the in-flight ceiling', () => {
    const setCeiling = (value: number) =>
      harness.app.get(RuntimeSettingService).set({
        key: 'agents.max_concurrent_runs_per_organization',
        value,
        actorUserId: superAdmin.id,
      });

    const clearCeiling = () =>
      harness.app
        .get(RuntimeSettingService)
        .reset('agents.max_concurrent_runs_per_organization');

    afterEach(clearCeiling);

    it('refuses a new request once the organization is at its limit', async () => {
      await setCeiling(1);

      expect((await request(spender)).status).toBe(201);

      const refused = await request(spender);
      expect(refused.status).toBe(429);
      expect(errorBody(refused).errorCode).toBe('TOO_MANY_REQUESTS');
    });

    /**
     * A caller retrying a request that already succeeded has been accepted and
     * already paid for. Refusing their retry at a ceiling they are themselves
     * occupying would strand a run they can no longer reach the id of.
     */
    it('still answers an honest retry of a run that is already in flight', async () => {
      await setCeiling(1);

      const key = freshKey();
      const first = dataOf<Operation>(
        (await request(spender, REQUEST, key)).body,
      );

      const retry = await request(spender, REQUEST, key);

      expect(retry.status).toBe(201);
      expect(dataOf<Operation>(retry.body).id).toBe(first.id);
    });

    it('counts only this organization', async () => {
      await setCeiling(1);

      expect((await request(spender)).status).toBe(201);

      const other = await request(
        outsider,
        REQUEST,
        freshKey(),
        otherOrganizationId,
      );
      expect(other.status).toBe(201);
    });

    it('makes room again once a run reaches a terminal state', async () => {
      await setCeiling(1);

      const operation = dataOf<Operation>((await request(spender)).body);

      await harness.prisma.agentRun.update({
        where: { id: operation.id },
        data: { status: 'SUCCEEDED' },
      });

      expect((await request(spender)).status).toBe(201);
    });
  });
});
