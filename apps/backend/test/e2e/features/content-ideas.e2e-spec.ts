import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';

import { Client } from 'pg';

import {
  AGENT_RUN_CAPACITY_LOCK,
  CONTENT_IDEA_AGENT_ID,
} from '../../../src/features/agent-management';
import { OrganizationAgentInstallationService } from '../../../src/features/agent-management/organization-agent-installation.service';
import {
  FeatureFlagService,
  RuntimeSettingService,
} from '../../../src/features/control-plane';
import {
  as,
  createHarness,
  createUser,
  errorBody,
  type Harness,
  type TestUser,
} from '../../support/auth-harness';

/**
 * The actor recorded on control-plane writes this harness makes.
 *
 * The audit log records who changed a flag, and these setups change flags — so
 * every call has to name somebody. A fixed non-user id rather than a session
 * user: the events are the harness's own, and attributing them to a test member
 * would put rows in the log that read as though a member of the organization
 * had reached the operator surface.
 */
const CONTROL_PLANE_ACTOR = 'e2e-harness';

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

type Availability = { available: boolean; reason: string | null };

/** Both gates acceptance checks, coarse first. */
const ENABLED_FLAGS = ['agents.enabled', 'content_ideas.enabled'] as const;

const REQUEST = {
  topic: 'Electric kettles',
  goal: 'Sell the autumn range before December',
  language: 'en',
  audience: 'Home cooks',
  numberOfIdeas: 3,
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
  /**
   * A third, for the requests that are *refused*.
   *
   * A refusal still costs a token against the per-user budget, and the
   * validation table below sends one per malformed body — so growing that
   * table would silently spend the owner's allowance and fail a later test with
   * a 429 that has nothing to do with what it asserts. Whose session sends a
   * request that is going to be refused is not part of what those cases claim.
   */
  let rejector: TestUser;
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

  const installContentIdeaAgent = (target: string) =>
    harness.app.get(OrganizationAgentInstallationService).create(
      target,
      {
        agentId: CONTENT_IDEA_AGENT_ID,
        definitionVersion: 1,
        enabled: true,
        configuration: {},
      },
      superAdmin.id,
    );

  const removeContentIdeaAgent = async (target: string) => {
    const where = { organizationId: target, agentId: CONTENT_IDEA_AGENT_ID };
    await harness.prisma.organizationAgentInstallation.updateMany({
      where,
      data: { activeVersionId: null },
    });
    await harness.prisma.organizationAgentVersion.deleteMany({
      where: {
        organizationId: target,
        installation: { agentId: CONTENT_IDEA_AGENT_ID },
      },
    });
    await harness.prisma.organizationAgentInstallation.deleteMany({ where });
  };

  // The real Better Auth flow deliberately creates eight independently signed
  // in users. Password hashing can exceed Jest's generic five-second hook
  // budget on a loaded CI worker; this is setup cost, not a product retry.
  beforeAll(async () => {
    harness = await createHarness();

    owner = await createUser(harness);
    orgAdmin = await createUser(harness);
    member = await createUser(harness);
    spender = await createUser(harness);
    secondSpender = await createUser(harness);
    rejector = await createUser(harness);
    outsider = await createUser(harness);
    superAdmin = await createUser(harness, { role: 'super_admin' });

    organizationId = await createOrganization(owner, 'ideas-acme');
    otherOrganizationId = await createOrganization(outsider, 'ideas-other');

    await addMember(orgAdmin, 'admin', organizationId, owner);
    await addMember(member, 'member', organizationId, owner);
    await addMember(spender, 'admin', organizationId, owner);
    await addMember(secondSpender, 'admin', organizationId, owner);
    await addMember(rejector, 'admin', organizationId, owner);

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

    await installContentIdeaAgent(organizationId);
    await installContentIdeaAgent(otherOrganizationId);
  }, 30_000);

  afterAll(async () => {
    for (const key of ENABLED_FLAGS) {
      for (const target of [organizationId, otherOrganizationId]) {
        await harness.app.get(FeatureFlagService).clearOrganizationOverride({
          actorUserId: CONTROL_PLANE_ACTOR,
          key,
          organizationId: target,
        });
      }
    }

    await clearRuns();
    await removeContentIdeaAgent(organizationId);
    await removeContentIdeaAgent(otherOrganizationId);
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
      expect(run.organizationAgentVersionId).not.toBeNull();
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
        (
          await request(owner, {
            topic: '  Kettles  ',
            goal: '  Book demos  ',
            language: 'ar',
            audience: 'Cooks',
          })
        ).body,
      );

      const run = await harness.prisma.agentRun.findUniqueOrThrow({
        where: { id: operation.id },
      });

      // Trimmed, and the default applied — the run executes what was parsed.
      expect(run.input).toEqual({
        topic: 'Kettles',
        goal: 'Book demos',
        language: 'ar',
        audience: 'Cooks',
        numberOfIdeas: 5,
      });
    });

    it.each([
      ['no topic', { goal: 'Sell more', language: 'en' }],
      ['no goal', { topic: 'Kettles', language: 'en' }],
      ['no language', { topic: 'Kettles', goal: 'Sell more' }],
      ['an unsupported language', { ...REQUEST, language: 'fr' }],
      ['a count beyond the contract', { ...REQUEST, numberOfIdeas: 99 }],
      [
        'the old field name',
        { ...REQUEST, numberOfIdeas: undefined, count: 3 },
      ],
      ['an unrecognized field', { ...REQUEST, model: 'gpt-5' }],
    ])('refuses %s', async (_name, body) => {
      const response = await request(rejector, body);

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
            {
              topic: 'Kettles',
              goal: 'Sell more',
              language: 'en',
              audience: 'Cooks',
              numberOfIdeas: 3,
            },
            key,
          )
        ).body,
      );
      const second = dataOf<Operation>(
        (
          await request(
            owner,
            {
              numberOfIdeas: 3,
              audience: 'Cooks',
              language: 'en',
              goal: 'Sell more',
              topic: 'Kettles',
            },
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

    /**
     * The readiness surface the screen loads before it shows a form.
     *
     * Without it the only way to learn the feature is off is to fill the form
     * in and press the button — which is how an operator concludes the product
     * is broken. What it must *not* be is the control-plane API: an ordinary
     * member holds no platform permission, and handing them one so a screen can
     * grey out a button would trade a small UX problem for a large
     * authorization one.
     */
    describe('availability', () => {
      const availability = (user: TestUser, target = organizationId) =>
        as(harness, user).get(`${base(target)}/availability`);

      it('reports available when both switches are on', async () => {
        const response = await availability(orgAdmin);

        expect(response.status).toBe(200);
        expect(dataOf<Availability>(response.body)).toEqual({
          available: true,
          reason: null,
        });
      });

      it('names the per-feature switch when it is the one that is off', async () => {
        await withFlag('content_ideas.enabled', false, async () => {
          expect(
            dataOf<Availability>((await availability(orgAdmin)).body),
          ).toEqual({ available: false, reason: 'content_ideas_disabled' });
        });
      });

      /**
       * The coarse switch is named first when both are off, matching the order
       * acceptance checks them in — so the screen and the refusal agree about
       * which control an operator has to touch.
       */
      it('names the coarse switch when it is off', async () => {
        await withFlag('agents.enabled', false, async () => {
          expect(
            dataOf<Availability>((await availability(orgAdmin)).body),
          ).toEqual({ available: false, reason: 'agents_disabled' });
        });
      });

      it('names the coarse switch when both are off', async () => {
        await withFlag('agents.enabled', false, async () => {
          await withFlag('content_ideas.enabled', false, async () => {
            expect(
              dataOf<Availability>((await availability(orgAdmin)).body).reason,
            ).toBe('agents_disabled');
          });
        });
      });

      it('reports a missing installation and acceptance refuses it', async () => {
        await removeContentIdeaAgent(organizationId);

        try {
          expect(
            dataOf<Availability>((await availability(orgAdmin)).body),
          ).toEqual({ available: false, reason: 'agent_not_installed' });

          const refused = await request(rejector);
          expect(refused.status).toBe(404);
          expect(errorBody(refused).errorCode).toBe('NOT_FOUND');
          await expect(
            harness.prisma.agentRun.count({ where: { organizationId } }),
          ).resolves.toBe(0);
        } finally {
          await installContentIdeaAgent(organizationId);
        }
      });

      it('reports a disabled installation and acceptance refuses it', async () => {
        const installations = harness.app.get(
          OrganizationAgentInstallationService,
        );
        const current =
          await harness.prisma.organizationAgentInstallation.findUniqueOrThrow({
            where: {
              organizationId_agentId: {
                organizationId,
                agentId: CONTENT_IDEA_AGENT_ID,
              },
            },
          });
        await installations.replace(
          organizationId,
          current.id,
          {
            expectedRevision: current.revision,
            definitionVersion: 1,
            enabled: false,
            configuration: {},
          },
          superAdmin.id,
        );

        try {
          expect(
            dataOf<Availability>((await availability(orgAdmin)).body),
          ).toEqual({ available: false, reason: 'agent_disabled' });

          const refused = await request(rejector);
          expect(refused.status).toBe(403);
          expect(errorBody(refused).errorCode).toBe('FEATURE_DISABLED');
          await expect(
            harness.prisma.agentRun.count({ where: { organizationId } }),
          ).resolves.toBe(0);
        } finally {
          const disabled =
            await harness.prisma.organizationAgentInstallation.findUniqueOrThrow(
              {
                where: { id: current.id },
              },
            );
          await installations.replace(
            organizationId,
            current.id,
            {
              expectedRevision: disabled.revision,
              definitionVersion: 1,
              enabled: true,
              configuration: {},
            },
            superAdmin.id,
          );
        }
      });

      /**
       * Readable by a member who may not spend. The screen has to explain why
       * nothing is being generated to everyone looking at it, not only to the
       * people who could have generated it.
       */
      it('is readable by a plain member', async () => {
        expect((await availability(member)).status).toBe(200);
      });

      it('tells a non-member nothing', async () => {
        expect((await availability(outsider)).status).toBe(404);
        expect((await availability(superAdmin)).status).toBe(404);
      });

      it('answers for the organization in the path', async () => {
        expect((await availability(owner, otherOrganizationId)).status).toBe(
          404,
        );
      });

      /**
       * The route is declared before `:operationId`, and Nest matches in
       * declaration order — so a parameterised segment moved above it would
       * swallow this path and answer it as a lookup for an operation called
       * "availability". Pinned here because the failure is a 404 on a route
       * that exists, which reads as the feature being missing.
       */
      it('is not shadowed by the operation lookup', async () => {
        const response = await availability(orgAdmin);

        expect(response.status).toBe(200);
        expect(response.body).not.toMatchObject({
          error: { code: 'NOT_FOUND' },
        });
      });

      /**
       * Availability is advisory and acceptance is authoritative. A flag
       * switched off between the two must produce a refusal, not a run — the
       * screen's answer is stale by construction and must never be what
       * decides.
       */
      it('does not authorize a request when the flag changes after it was read', async () => {
        expect(
          dataOf<Availability>((await availability(orgAdmin)).body).available,
        ).toBe(true);

        await withFlag('content_ideas.enabled', false, async () => {
          const refused = await request(orgAdmin);

          expect(refused.status).toBe(403);
          expect(errorBody(refused).errorCode).toBe('FEATURE_DISABLED');
        });
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
      harness.app.get(RuntimeSettingService).reset({
        key: 'agents.max_concurrent_runs_per_organization',
        actorUserId: CONTROL_PLANE_ACTOR,
      });

    afterEach(clearCeiling);

    it('refuses a new request once the organization is at its limit', async () => {
      await setCeiling(1);

      expect((await request(spender)).status).toBe(201);

      const refused = await request(spender);
      expect(refused.status).toBe(429);
      expect(errorBody(refused).errorCode).toBe('TOO_MANY_REQUESTS');
    });

    /**
     * The ceiling is exact, not best-effort.
     *
     * Counting in-flight runs and then inserting one is a read-modify-write,
     * and under PostgreSQL's default isolation two of them interleave freely:
     * both read one, both see room, both commit, and an organization limited to
     * one run has two. Nothing about that is visible afterwards — the runs look
     * ordinary and the bill is simply larger than the operator set.
     *
     * Two different members with two different keys, dispatched together, so
     * neither the idempotency short-circuit nor the per-user limiter can be
     * what produces the refusal. Exactly one accept and exactly one 429 is the
     * claim, and the durable row count is checked as well: an assertion on
     * status codes alone would pass for an implementation that answered 429
     * *after* committing the second run.
     */
    it('accepts exactly one of two simultaneous requests at a limit of one', async () => {
      await setCeiling(1);

      const [first, second] = await Promise.all([
        request(spender, REQUEST, freshKey()),
        request(secondSpender, REQUEST, freshKey()),
      ]);

      const statuses = [first.status, second.status].sort();

      expect(statuses).toEqual([201, 429]);
      expect(errorBody(first.status === 429 ? first : second).errorCode).toBe(
        'TOO_MANY_REQUESTS',
      );

      expect(
        await harness.prisma.agentRun.count({
          where: {
            organizationId,
            status: { in: ['QUEUED', 'RUNNING'] },
          },
        }),
      ).toBe(1);
    });

    /**
     * The deterministic proof that the lock exists and is keyed on the
     * organization.
     *
     * Two requests dispatched with `Promise.all` through supertest do not
     * reliably overlap at the database — the event loop and the connection pool
     * can finish the first transaction before the second opens one — so the
     * pair test above is a functional check rather than a proof: it passes with
     * or without the lock. Removing the lock and watching it stay green is
     * exactly how that was discovered.
     *
     * This holds the lock from outside on a dedicated connection, which is not
     * probabilistic. Acceptance for this organization cannot proceed while it
     * is held, acceptance for another proceeds immediately, and releasing it
     * lets the blocked request through. Together with the counting assertions
     * above, that is the whole of the exactness claim: the count and the insert
     * happen inside a lock nothing else for this tenant can hold at the same
     * time.
     */
    it('serializes acceptance per organization on an advisory lock', async () => {
      await setCeiling(5);

      const holder = new Client({ connectionString: process.env.DATABASE_URL });
      await holder.connect();

      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
          AGENT_RUN_CAPACITY_LOCK,
          organizationId,
        ]);

        const blocked = request(spender, REQUEST, freshKey());

        // It must still be waiting. A generous window: the assertion is that it
        // does *not* settle, so a slow machine makes this more reliable rather
        // than less.
        const settled = Symbol('settled');
        const raced = await Promise.race([
          blocked.then(() => settled),
          new Promise((resolve) => setTimeout(resolve, 1_500)),
        ]);

        expect(raced).not.toBe(settled);

        // And the lock is this organization's alone.
        const other = await request(
          outsider,
          REQUEST,
          freshKey(),
          otherOrganizationId,
        );

        expect(other.status).toBe(201);

        await holder.query('COMMIT');

        expect((await blocked).status).toBe(201);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await holder.end();
      }
    }, 20_000);

    /**
     * And the lock is per organization, so one tenant's acceptance cannot be
     * blocked by another's.
     *
     * Both are dispatched together at a limit of one each. If the lock were
     * global rather than keyed on the organization the two would serialize —
     * which is still correct, so this asserts the outcome rather than the
     * timing: both are accepted, because neither is part of the other's count.
     */
    it('does not let one organization ceiling refuse another', async () => {
      await setCeiling(1);

      const [ours, theirs] = await Promise.all([
        request(spender, REQUEST, freshKey()),
        request(outsider, REQUEST, freshKey(), otherOrganizationId),
      ]);

      expect(ours.status).toBe(201);
      expect(theirs.status).toBe(201);
    });

    /**
     * The retry path, under contention.
     *
     * The accepted key is answered with its run even while the organization is
     * at capacity — and now that the check happens inside a lock, the lookup
     * that makes that true has to happen inside it too. An implementation that
     * took the lock and then checked capacity before the key would refuse a
     * retry it had already been paid for.
     */
    it('still answers an accepted key while a competing request is refused', async () => {
      await setCeiling(1);

      const key = freshKey();
      const first = dataOf<Operation>(
        (await request(spender, REQUEST, key)).body,
      );

      const [retry, competitor] = await Promise.all([
        request(spender, REQUEST, key),
        request(secondSpender, REQUEST, freshKey()),
      ]);

      expect(retry.status).toBe(201);
      expect(dataOf<Operation>(retry.body).id).toBe(first.id);
      expect(competitor.status).toBe(429);
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
