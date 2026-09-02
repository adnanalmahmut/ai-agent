import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { AgentDefinition } from '../../src/features/agent-management';
import { AgentDefinitionRegistry } from '../../src/ai/agents/agent-definition.registry';
import {
  CONTENT_IDEA_AGENT_ID,
  CONTENT_IDEA_AGENT_VERSION,
} from '../../src/features/content/ideas/agent-definitions/content-idea';
import { OrganizationAgentInstallationService } from '../../src/features/agent-management/organization-agent-installation.service';
import { MODEL_IDS } from '../../src/ai/models/model-catalog';
import {
  as,
  createHarness,
  createUser,
  errorBody,
  type Harness,
  type TestUser,
} from '../support/auth-harness';

const configurableDefinitions: AgentDefinition[] = [
  {
    id: 'e2e-configurable-agent',
    version: 1,
    runtime: 'mastra',
    instructions: 'test',
    model: MODEL_IDS.openAiGpt4oMini,
    modelPolicy: {
      id: 'e2e-configurable-agent.model-policy.1',
      allowedModelIds: [MODEL_IDS.openAiGpt4oMini],
    },
    input: z.unknown(),
    output: z.unknown(),
    organizationConfiguration: {
      schema: z.object({ tone: z.enum(['plain', 'warm']) }).strict(),
      defaultValue: { tone: 'plain' },
    },
  },
  {
    id: 'e2e-configurable-agent',
    version: 2,
    runtime: 'mastra',
    instructions: 'test v2',
    model: MODEL_IDS.openAiGpt4oMini,
    modelPolicy: {
      id: 'e2e-configurable-agent.model-policy.2',
      allowedModelIds: [MODEL_IDS.openAiGpt4oMini],
    },
    input: z.unknown(),
    output: z.unknown(),
    organizationConfiguration: {
      schema: z
        .object({ tone: z.enum(['plain', 'warm']), count: z.number().int() })
        .strict(),
      defaultValue: { tone: 'warm', count: 2 },
    },
  },
];

describe('Organization agent installations (e2e)', () => {
  let harness: Harness;
  let owner: TestUser;
  let admin: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let superAdmin: TestUser;
  let otherOwner: TestUser;
  let organizationId: string;
  let otherOrganizationId: string;
  let service: OrganizationAgentInstallationService;

  const route = (suffix = '') =>
    `/organizations/${organizationId}/agent-installations${suffix}`;

  const dataOf = <T>(response: { body: unknown }): T =>
    (response.body as { data: T }).data;

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

  const addMember = async (invitee: TestUser, role: string) => {
    const invite = await as(harness, owner).post(
      '/api/auth/organization/invite-member',
      { email: invitee.email, role, organizationId },
    );
    expect(invite.status).toBe(200);
    const accepted = await as(harness, invitee).post(
      '/api/auth/organization/accept-invitation',
      { invitationId: (invite.body as { id: string }).id },
    );
    expect(accepted.status).toBe(200);
  };

  const installContentIdea = async (user: TestUser = owner, enabled = true) => {
    const response = await as(harness, user).post(route(), {
      agentId: CONTENT_IDEA_AGENT_ID,
      definitionVersion: CONTENT_IDEA_AGENT_VERSION,
      enabled,
      modelId: MODEL_IDS.openAiGpt4oMini,
    });
    expect(response.status).toBe(201);
    return dataOf<{
      id: string;
      revision: number;
      activeVersionId: string;
    }>(response);
  };

  const cleanInstallations = async () => {
    const where = {
      organizationId: { in: [organizationId, otherOrganizationId] },
    };
    await harness.prisma.organizationAgentInstallation.updateMany({
      where,
      data: { activeVersionId: null },
    });
    await harness.prisma.organizationAgentVersion.deleteMany({ where });
    await harness.prisma.organizationAgentInstallation.deleteMany({ where });
  };

  beforeAll(async () => {
    harness = await createHarness();
    owner = await createUser(harness);
    admin = await createUser(harness);
    member = await createUser(harness);
    outsider = await createUser(harness);
    superAdmin = await createUser(harness, { role: 'super_admin' });
    otherOwner = await createUser(harness);

    organizationId = await createOrganization(owner, 'Agent Install E2E A');
    otherOrganizationId = await createOrganization(
      otherOwner,
      'Agent Install E2E B',
    );
    await addMember(admin, 'admin');
    await addMember(member, 'member');

    service = harness.app.get(OrganizationAgentInstallationService);
  }, 120_000);

  afterEach(async () => {
    await cleanInstallations();
  });

  afterAll(async () => {
    if (harness) {
      await cleanInstallations();
      await harness.close();
    }
  });

  it('exposes the bounded production catalog to owners and admins', async () => {
    const ownerResponse = await as(harness, owner).get(route('/catalog'));
    const adminResponse = await as(harness, admin).get(route('/catalog'));

    expect(ownerResponse.status).toBe(200);
    expect(adminResponse.status).toBe(200);
    expect(dataOf(ownerResponse)).toEqual([
      {
        agentId: CONTENT_IDEA_AGENT_ID,
        latestDefinitionVersion: CONTENT_IDEA_AGENT_VERSION,
        modelPolicyId: 'content-idea.model-policy.1',
        defaultModelId: MODEL_IDS.openAiGpt4oMini,
        allowedModelIds: [MODEL_IDS.openAiGpt4oMini],
        defaultConfiguration: {},
        // The published catalog states the definition's maximum so a client
        // can only ever narrow it. content-idea grants nothing.
        maxToolGrants: [],
      },
    ]);
  });

  it('refuses members and conceals the organization from non-members', async () => {
    const [memberResponse, outsiderResponse, superAdminResponse] =
      await Promise.all([
        as(harness, member).get(route('/catalog')),
        as(harness, outsider).get(route('/catalog')),
        as(harness, superAdmin).get(route('/catalog')),
      ]);

    expect(memberResponse.status).toBe(403);
    expect(outsiderResponse.status).toBe(404);
    expect(superAdminResponse.status).toBe(404);
  });

  it('runs authorization before body validation', async () => {
    const invalidBody = { secretCanary: 'must-never-be-stored' };
    const [memberResponse, outsiderResponse] = await Promise.all([
      as(harness, member).post(route(), invalidBody),
      as(harness, outsider).post(route(), invalidBody),
    ]);

    expect(memberResponse.status).toBe(403);
    expect(outsiderResponse.status).toBe(404);
  });

  it('creates one active immutable version and lists only its tenant', async () => {
    const created = await installContentIdea(admin);
    const listed = await as(harness, owner).get(route());

    expect(created).toMatchObject({ revision: 1 });
    expect(created.activeVersionId).toBeTruthy();
    expect(listed.status).toBe(200);
    expect(dataOf(listed)).toEqual([
      expect.objectContaining({
        id: created.id,
        organizationId,
        agentId: CONTENT_IDEA_AGENT_ID,
        revision: 1,
        activeVersion: expect.objectContaining({
          enabled: true,
          definitionVersion: CONTENT_IDEA_AGENT_VERSION,
          modelPolicyId: 'content-idea.model-policy.1',
          modelId: MODEL_IDS.openAiGpt4oMini,
          configuration: {},
          createdByUserId: admin.id,
        }),
      }),
    ]);
    await expect(
      harness.prisma.organizationAgentVersion.count({
        where: { organizationId },
      }),
    ).resolves.toBe(1);
  });

  it('refuses unknown definitions, arbitrary fields, and secret-like configuration', async () => {
    const unknown = await as(harness, owner).post(route(), {
      agentId: 'unknown-agent',
      definitionVersion: 1,
      enabled: true,
      configuration: {},
    });
    const arbitrary = await as(harness, owner).post(route(), {
      agentId: CONTENT_IDEA_AGENT_ID,
      definitionVersion: CONTENT_IDEA_AGENT_VERSION,
      enabled: true,
      runtime: 'request-owned',
    });
    const canary = await as(harness, owner).post(route(), {
      agentId: CONTENT_IDEA_AGENT_ID,
      definitionVersion: CONTENT_IDEA_AGENT_VERSION,
      enabled: true,
      configuration: { apiKey: 'must-never-be-stored' },
    });

    expect(unknown.status).toBe(404);
    expect(arbitrary.status).toBe(400);
    expect(canary.status).toBe(400);
    expect(errorBody(canary).errorCode).toBe('VALIDATION_ERROR');
    await expect(
      harness.prisma.organizationAgentInstallation.count({
        where: { organizationId },
      }),
    ).resolves.toBe(0);
  });

  it('accepts only stable policy-bounded model selection fields', async () => {
    const create = await as(harness, owner).post(route(), {
      agentId: CONTENT_IDEA_AGENT_ID,
      definitionVersion: CONTENT_IDEA_AGENT_VERSION,
      enabled: true,
      model: MODEL_IDS.openAiGpt4oMini,
    });

    expect(create.status).toBe(400);
    await expect(
      harness.prisma.organizationAgentInstallation.count({
        where: { organizationId },
      }),
    ).resolves.toBe(0);

    const installed = await installContentIdea();
    const update = await as(harness, owner).put(route(`/${installed.id}`), {
      expectedRevision: 1,
      definitionVersion: CONTENT_IDEA_AGENT_VERSION,
      enabled: false,
      configuration: {},
      model: MODEL_IDS.openAiGpt4oMini,
    });

    expect(update.status).toBe(400);
    await expect(
      harness.prisma.organizationAgentVersion.count({
        where: { installationId: installed.id },
      }),
    ).resolves.toBe(1);

    await cleanInstallations();
    const providerAlias = await as(harness, owner).post(route(), {
      agentId: CONTENT_IDEA_AGENT_ID,
      definitionVersion: CONTENT_IDEA_AGENT_VERSION,
      enabled: true,
      modelId: 'openai/gpt-4o-mini',
    });
    expect(providerAlias.status).toBe(400);

    const disallowedCapability = await as(harness, owner).post(route(), {
      agentId: CONTENT_IDEA_AGENT_ID,
      definitionVersion: CONTENT_IDEA_AGENT_VERSION,
      enabled: true,
      modelId: MODEL_IDS.openAiTextEmbedding3Small,
    });
    expect(disallowedCapability.status).toBe(400);
    expect(errorBody(disallowedCapability).error?.details).toEqual({
      reason: 'invalid_model_selection',
    });
  });

  it('enforces one installation per organization and agent', async () => {
    await installContentIdea();
    const duplicate = await as(harness, owner).post(route(), {
      agentId: CONTENT_IDEA_AGENT_ID,
      definitionVersion: CONTENT_IDEA_AGENT_VERSION,
      enabled: true,
      configuration: {},
    });

    expect(duplicate.status).toBe(409);
    expect(errorBody(duplicate).error?.details).toEqual({
      reason: 'already_installed',
    });
    await expect(
      harness.prisma.organizationAgentVersion.count({
        where: { organizationId },
      }),
    ).resolves.toBe(1);
  });

  it('scopes immutable revision uniqueness to one installation in PostgreSQL', async () => {
    const first = await service.create(
      organizationId,
      {
        agentId: CONTENT_IDEA_AGENT_ID,
        definitionVersion: CONTENT_IDEA_AGENT_VERSION,
        enabled: true,
      },
      owner.id,
    );
    const second = await service.create(
      otherOrganizationId,
      {
        agentId: CONTENT_IDEA_AGENT_ID,
        definitionVersion: CONTENT_IDEA_AGENT_VERSION,
        enabled: true,
      },
      otherOwner.id,
    );

    const constraints = await harness.prisma.$queryRaw<
      Array<{
        name: string;
        deferrable: boolean;
        initiallyDeferred: boolean;
      }>
    >`
      SELECT
        conname AS "name",
        condeferrable AS "deferrable",
        condeferred AS "initiallyDeferred"
      FROM pg_constraint
      WHERE conname IN (
        'organization_agent_version_installationId_revision_key',
        'organization_agent_installation_activeVersionId_id_fkey'
      )
      ORDER BY conname
    `;
    expect(constraints).toEqual([
      {
        name: 'organization_agent_installation_activeVersionId_id_fkey',
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        name: 'organization_agent_version_installationId_revision_key',
        deferrable: false,
        initiallyDeferred: false,
      },
    ]);

    await expect(
      harness.prisma.organizationAgentVersion.create({
        data: {
          organizationId,
          installationId: first.id,
          revision: 1,
          definitionVersion: CONTENT_IDEA_AGENT_VERSION,
          enabled: false,
          configuration: {},
          createdByUserId: owner.id,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    const committed = await harness.prisma.organizationAgentVersion.findMany({
      where: { installationId: { in: [first.id, second.id] } },
      orderBy: { installationId: 'asc' },
      select: { installationId: true, revision: true },
    });
    expect(committed).toHaveLength(2);
    expect(committed.map(({ revision }) => revision)).toEqual([1, 1]);
  });

  it('rolls pointer CAS back when the winning candidate cannot be inserted', async () => {
    const installed = await installContentIdea();
    const candidateId = randomUUID();

    await expect(
      harness.prisma.$transaction(async (tx) => {
        const switched = await tx.organizationAgentInstallation.updateMany({
          where: {
            id: installed.id,
            organizationId,
            revision: 1,
            activeVersionId: installed.activeVersionId,
          },
          data: { revision: { increment: 1 }, activeVersionId: candidateId },
        });
        expect(switched.count).toBe(1);

        // Deliberately reuse revision 1 so the new database invariant rejects
        // the candidate after CAS and the whole transaction must roll back.
        await tx.organizationAgentVersion.create({
          data: {
            id: candidateId,
            organizationId,
            installationId: installed.id,
            revision: 1,
            definitionVersion: CONTENT_IDEA_AGENT_VERSION,
            enabled: false,
            configuration: {},
            createdByUserId: owner.id,
          },
        });
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    await expect(
      harness.prisma.organizationAgentInstallation.findUniqueOrThrow({
        where: { id: installed.id },
        select: { revision: true, activeVersionId: true },
      }),
    ).resolves.toEqual({
      revision: 1,
      activeVersionId: installed.activeVersionId,
    });
    await expect(
      harness.prisma.organizationAgentVersion.count({
        where: { installationId: installed.id },
      }),
    ).resolves.toBe(1);
  });

  it('versions enabled state, keeps no-ops stable, and pages history', async () => {
    const installed = await installContentIdea();
    const changed = await as(harness, owner).put(route(`/${installed.id}`), {
      expectedRevision: 1,
      definitionVersion: CONTENT_IDEA_AGENT_VERSION,
      enabled: false,
      configuration: {},
    });
    expect(changed.status).toBe(200);
    expect(dataOf(changed)).toMatchObject({
      revision: 2,
      activeVersion: { enabled: false, revision: 2 },
    });

    const noOp = await as(harness, owner).put(route(`/${installed.id}`), {
      expectedRevision: 1,
      definitionVersion: CONTENT_IDEA_AGENT_VERSION,
      enabled: false,
      configuration: {},
    });
    expect(noOp.status).toBe(200);
    expect(dataOf(noOp)).toMatchObject({ revision: 2 });
    await expect(
      harness.prisma.organizationAgentVersion.count({
        where: { installationId: installed.id },
      }),
    ).resolves.toBe(2);

    const firstPage = await as(harness, owner).get(
      route(`/${installed.id}/versions?limit=1`),
    );
    expect(firstPage.status).toBe(200);
    const firstData = dataOf<{
      items: Array<{
        revision: number;
        modelPolicyId: string | null;
        modelId: string | null;
      }>;
      nextCursor: string | null;
    }>(firstPage);
    expect(firstData.items).toHaveLength(1);
    expect(firstData.items[0]).toMatchObject({
      revision: 2,
      modelPolicyId: 'content-idea.model-policy.1',
      modelId: MODEL_IDS.openAiGpt4oMini,
    });
    expect(firstData.nextCursor).toEqual(expect.any(String));

    const secondPage = await as(harness, owner).get(
      route(
        `/${installed.id}/versions?limit=1&cursor=${encodeURIComponent(
          firstData.nextCursor as string,
        )}`,
      ),
    );
    expect(secondPage.status).toBe(200);
    const secondData = dataOf<{
      items: Array<{
        revision: number;
        enabled: boolean;
        modelPolicyId: string | null;
        modelId: string | null;
      }>;
      nextCursor: string | null;
    }>(secondPage);
    expect(secondData.items).toEqual([
      expect.objectContaining({
        revision: 1,
        enabled: true,
        modelPolicyId: 'content-idea.model-policy.1',
        modelId: MODEL_IDS.openAiGpt4oMini,
      }),
    ]);
    expect(secondData.nextCursor).toBeNull();
  });

  it('conceals guessed and cross-tenant installation ids and exposes no mutation routes for history', async () => {
    const installed = await installContentIdea();
    const otherPath = `/organizations/${otherOrganizationId}/agent-installations/${installed.id}`;

    const [guessed, crossTenant, crossHistory] = await Promise.all([
      as(harness, owner).put(route('/guessed-id'), {
        expectedRevision: 1,
        definitionVersion: 1,
        enabled: false,
        configuration: {},
      }),
      as(harness, otherOwner).put(otherPath, {
        expectedRevision: 1,
        definitionVersion: 1,
        enabled: false,
        configuration: {},
      }),
      as(harness, otherOwner).get(`${otherPath}/versions`),
    ]);

    expect(guessed.status).toBe(404);
    expect(crossTenant.status).toBe(404);
    expect(crossHistory.status).toBe(404);
    await as(harness, owner)
      .del(route(`/${installed.id}`))
      .expect(404);
  });

  it('commits one different concurrent replacement and lets the CAS loser create no candidate', async () => {
    const dbService = new OrganizationAgentInstallationService(
      harness.prisma,
      new AgentDefinitionRegistry(configurableDefinitions),
    );
    const installed = await dbService.create(
      organizationId,
      {
        agentId: 'e2e-configurable-agent',
        definitionVersion: 1,
        enabled: true,
        configuration: { tone: 'plain' },
      },
      owner.id,
    );

    const outcomes = await Promise.allSettled([
      dbService.replace(
        organizationId,
        installed.id,
        {
          expectedRevision: 1,
          definitionVersion: 2,
          enabled: true,
          configuration: { tone: 'warm', count: 4 },
        },
        owner.id,
      ),
      dbService.replace(
        organizationId,
        installed.id,
        {
          expectedRevision: 1,
          definitionVersion: 1,
          enabled: false,
          configuration: { tone: 'warm' },
        },
        admin.id,
      ),
    ]);

    expect(
      outcomes.filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = outcomes.find(({ status }) => status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      code: 'CONFLICT',
    });
    await expect(
      harness.prisma.organizationAgentVersion.count({
        where: { installationId: installed.id },
      }),
    ).resolves.toBe(2);
    await expect(
      harness.prisma.organizationAgentVersion.findMany({
        where: { installationId: installed.id },
        orderBy: { revision: 'asc' },
        select: { revision: true },
      }),
    ).resolves.toEqual([{ revision: 1 }, { revision: 2 }]);
  });

  it('makes concurrent identical replacements idempotent with one committed version', async () => {
    const dbService = new OrganizationAgentInstallationService(
      harness.prisma,
      new AgentDefinitionRegistry(configurableDefinitions),
    );
    const installed = await dbService.create(
      organizationId,
      {
        agentId: 'e2e-configurable-agent',
        definitionVersion: 1,
        enabled: true,
        configuration: { tone: 'plain' },
      },
      owner.id,
    );
    const replacement = {
      expectedRevision: 1,
      definitionVersion: 2,
      enabled: true,
      configuration: { tone: 'warm', count: 4 },
    } as const;

    const results = await Promise.all([
      dbService.replace(organizationId, installed.id, replacement, owner.id),
      dbService.replace(organizationId, installed.id, replacement, admin.id),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ revision: 2 }),
      expect.objectContaining({ revision: 2 }),
    ]);
    expect(results[0]?.activeVersionId).toBe(results[1]?.activeVersionId);
    await expect(
      harness.prisma.organizationAgentVersion.count({
        where: { installationId: installed.id },
      }),
    ).resolves.toBe(2);
  });

  it('enforces active-pointer installation identity and version tenant identity in PostgreSQL', async () => {
    const first = await service.create(
      organizationId,
      {
        agentId: CONTENT_IDEA_AGENT_ID,
        definitionVersion: 1,
        enabled: true,
      },
      owner.id,
    );
    const second = await service.create(
      otherOrganizationId,
      {
        agentId: CONTENT_IDEA_AGENT_ID,
        definitionVersion: 1,
        enabled: true,
      },
      otherOwner.id,
    );

    await expect(
      harness.prisma.organizationAgentInstallation.update({
        where: { id: first.id },
        data: { activeVersionId: second.activeVersionId },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });

    await expect(
      harness.prisma.organizationAgentVersion.create({
        data: {
          organizationId: otherOrganizationId,
          installationId: first.id,
          revision: 99,
          definitionVersion: 1,
          enabled: true,
          configuration: {},
          createdByUserId: owner.id,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
});
