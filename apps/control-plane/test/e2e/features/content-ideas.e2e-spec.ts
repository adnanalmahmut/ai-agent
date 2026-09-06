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

import { AGENT_RUN_CAPACITY_LOCK } from '../../../src/modules/runs';
import { CONTENT_IDEA_AGENT_ID } from '../../../src/features/content/ideas/agent-definitions';
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

const CONTROL_PLANE_ACTOR = 'e2e-harness';

type Operation = {
  id: string;
  status: string;
  output: unknown;
  completedAt: string | null;
};

const dataOf = <T>(body: unknown): T => (body as { data: T }).data;

type Availability = { available: boolean; reason: string | null };

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
  let spender: TestUser;
  let secondSpender: TestUser;
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

        const read = await as(harness, orgAdmin).get(
          `${base()}/${operation.id}`,
        );
        expect(read.status).toBe(200);
      });
    });

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

      it('is not shadowed by the operation lookup', async () => {
        const response = await availability(orgAdmin);

        expect(response.status).toBe(200);
        expect(response.body).not.toMatchObject({
          error: { code: 'NOT_FOUND' },
        });
      });

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

        const settled = Symbol('settled');
        const raced = await Promise.race([
          blocked.then(() => settled),
          new Promise((resolve) => setTimeout(resolve, 1_500)),
        ]);

        expect(raced).not.toBe(settled);

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

    it('does not let one organization ceiling refuse another', async () => {
      await setCeiling(1);

      const [ours, theirs] = await Promise.all([
        request(spender, REQUEST, freshKey()),
        request(outsider, REQUEST, freshKey(), otherOrganizationId),
      ]);

      expect(ours.status).toBe(201);
      expect(theirs.status).toBe(201);
    });

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
