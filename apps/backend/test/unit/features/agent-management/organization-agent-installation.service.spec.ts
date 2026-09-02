import { describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';

import type { PrismaService } from '../../../../src/infrastructure/database';
import { Prisma } from '../../../../src/generated/prisma/client';
import { MODEL_IDS } from '../../../../src/ai/models/model-catalog';
import { AgentDefinitionRegistry } from '../../../../src/ai/agents/agent-definition.registry';
import type { AgentDefinition } from '../../../../src/ai/agents/agent.types';
import { OrganizationAgentInstallationService } from '../../../../src/features/agent-management/organization-agent-installation.service';

const configurableV1: AgentDefinition = {
  id: 'configurable',
  version: 1,
  runtime: 'mastra',
  instructions: 'test',
  model: MODEL_IDS.openAiGpt4oMini,
  modelPolicy: {
    id: 'configurable.model-policy.1',
    allowedModelIds: [MODEL_IDS.openAiGpt4oMini],
  },
  input: z.unknown(),
  output: z.unknown(),
  organizationConfiguration: {
    schema: z.object({ tone: z.enum(['plain', 'warm']) }).strict(),
    defaultValue: { tone: 'plain' },
  },
};

const configurableV2: AgentDefinition = {
  ...configurableV1,
  version: 2,
  modelPolicy: {
    id: 'configurable.model-policy.2',
    allowedModelIds: [MODEL_IDS.openAiGpt4oMini],
  },
  organizationConfiguration: {
    schema: z
      .object({ tone: z.enum(['plain', 'warm']), count: z.number().int() })
      .strict(),
    defaultValue: { tone: 'warm', count: 2 },
  },
};

const internalOnly: AgentDefinition = {
  ...configurableV1,
  id: 'internal-only',
  modelPolicy: {
    id: 'internal-only.model-policy.1',
    allowedModelIds: [MODEL_IDS.openAiGpt4oMini],
  },
  organizationConfiguration: undefined,
};

const registry = () =>
  new AgentDefinitionRegistry([configurableV1, configurableV2, internalOnly]);

const persistedVersion = (
  overrides: Partial<{
    id: string;
    revision: number;
    definitionVersion: number;
    enabled: boolean;
    configuration: Prisma.JsonValue;
    modelPolicyId: string | null;
    modelId: string | null;
    toolGrants: string[];
  }> = {},
) => ({
  id: overrides.id ?? 'version-1',
  organizationId: 'org-1',
  installationId: 'installation-1',
  revision: overrides.revision ?? 1,
  definitionVersion: overrides.definitionVersion ?? 1,
  modelPolicyId:
    overrides.modelPolicyId ??
    `configurable.model-policy.${overrides.definitionVersion ?? 1}`,
  modelId: overrides.modelId ?? MODEL_IDS.openAiGpt4oMini,
  enabled: overrides.enabled ?? true,
  configuration: overrides.configuration ?? { tone: 'plain' },
  // The column is defaulted, so a persisted row always carries an array.
  toolGrants: overrides.toolGrants ?? [],
  createdByUserId: 'actor-1',
  createdAt: new Date('2026-08-27T00:00:00.000Z'),
});

const persistedInstallation = (
  version = persistedVersion(),
  overrides: Partial<{ revision: number; activeVersionId: string }> = {},
) => ({
  id: 'installation-1',
  organizationId: 'org-1',
  agentId: 'configurable',
  revision: overrides.revision ?? version.revision,
  activeVersionId: overrides.activeVersionId ?? version.id,
  activeVersion: version,
  createdAt: new Date('2026-08-27T00:00:00.000Z'),
  updatedAt: new Date('2026-08-27T00:00:00.000Z'),
});

describe('AgentDefinitionRegistry organization configuration', () => {
  it('lists only the latest installable definition for each agent', () => {
    expect(
      registry()
        .listInstallable()
        .map(({ id, version }) => ({ id, version })),
    ).toEqual([{ id: 'configurable', version: 2 }]);
  });

  it('parses the exact requested revision and applies its owned default', () => {
    const definitions = registry();

    expect(
      definitions.parseOrganizationConfiguration('configurable', 1, undefined),
    ).toEqual({ tone: 'plain' });
    expect(() =>
      definitions.parseOrganizationConfiguration('configurable', 1, {
        tone: 'warm',
        count: 2,
      }),
    ).toThrow(z.ZodError);
    expect(
      definitions.parseOrganizationConfiguration('configurable', 2, {
        tone: 'warm',
        count: 3,
      }),
    ).toEqual({ tone: 'warm', count: 3 });
  });

  it('refuses internal-only and unregistered definitions', () => {
    const definitions = registry();

    expect(() =>
      definitions.parseOrganizationConfiguration('internal-only', 1, {}),
    ).toThrow('is not installable');
    expect(() =>
      definitions.parseOrganizationConfiguration('configurable', 9, {}),
    ).toThrow('is not registered');
  });
});

describe('OrganizationAgentInstallationService', () => {
  it('parses catalog defaults rather than exposing unchecked definition data', () => {
    const malformed = {
      ...configurableV1,
      organizationConfiguration: {
        ...configurableV1.organizationConfiguration,
        defaultValue: { tone: 'not-a-valid-tone' },
      },
    } as unknown as AgentDefinition;
    const service = new OrganizationAgentInstallationService(
      {} as PrismaService,
      new AgentDefinitionRegistry([malformed]),
    );

    expect(() => service.catalog()).toThrow(z.ZodError);
  });

  it('returns a copy of the policy maximum from each catalog read', () => {
    const service = new OrganizationAgentInstallationService(
      {} as PrismaService,
      registry(),
    );
    const first = service.catalog()[0];
    (first.allowedModelIds as unknown as string[]).push(
      MODEL_IDS.openAiTextEmbedding3Small,
    );

    expect(service.catalog()[0].allowedModelIds).toEqual([
      MODEL_IDS.openAiGpt4oMini,
    ]);
  });

  it('creates the installation, first version, and active pointer in one transaction', async () => {
    const version = persistedVersion();
    const installation = persistedInstallation(version);
    const tx = {
      organizationAgentInstallation: {
        create: jest.fn<(input: unknown) => Promise<{ id: string }>>(() =>
          Promise.resolve({ id: installation.id }),
        ),
        update: jest.fn<(input: unknown) => Promise<object>>(() =>
          Promise.resolve({}),
        ),
        findUniqueOrThrow: jest.fn(() => Promise.resolve(installation)),
      },
      organizationAgentVersion: {
        create: jest.fn<(input: unknown) => Promise<{ id: string }>>(() =>
          Promise.resolve({ id: version.id }),
        ),
      },
    };
    const prisma = {
      $transaction: jest.fn((operation: (client: typeof tx) => unknown) =>
        operation(tx),
      ),
    } as unknown as PrismaService;
    const service = new OrganizationAgentInstallationService(
      prisma,
      registry(),
    );

    await expect(
      service.create(
        'org-1',
        {
          agentId: 'configurable',
          definitionVersion: 1,
          enabled: true,
        },
        'actor-1',
      ),
    ).resolves.toMatchObject({ revision: 1, activeVersionId: version.id });
    expect(tx.organizationAgentVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          revision: 1,
          modelPolicyId: configurableV1.modelPolicy.id,
          modelId: MODEL_IDS.openAiGpt4oMini,
          configuration: { tone: 'plain' },
        }),
      }),
    );
    expect(tx.organizationAgentInstallation.update).toHaveBeenCalledWith({
      where: { id: installation.id },
      data: { revision: 1, activeVersionId: version.id },
    });
  });

  it('refuses a known catalog model outside the definition policy', async () => {
    const service = new OrganizationAgentInstallationService(
      {} as PrismaService,
      registry(),
    );

    await expect(
      service.create(
        'org-1',
        {
          agentId: 'configurable',
          definitionVersion: 1,
          enabled: true,
          modelId: MODEL_IDS.openAiTextEmbedding3Small,
        },
        'actor-1',
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      publicDetails: { reason: 'invalid_model_selection' },
    });
  });

  it('returns an identical replacement without inserting a version', async () => {
    const current = persistedInstallation(
      persistedVersion({ configuration: { tone: 'plain' } }),
    );
    const createVersion = jest.fn();
    const tx = {
      organizationAgentInstallation: {
        findFirst: jest.fn(() => Promise.resolve(current)),
      },
      organizationAgentVersion: { create: createVersion },
    };
    const prisma = {
      $transaction: jest.fn((operation: (client: typeof tx) => unknown) =>
        operation(tx),
      ),
    } as unknown as PrismaService;
    const service = new OrganizationAgentInstallationService(
      prisma,
      registry(),
    );

    await expect(
      service.replace(
        'org-1',
        'installation-1',
        {
          expectedRevision: 1,
          definitionVersion: 1,
          enabled: true,
          configuration: { tone: 'plain' },
        },
        'actor-1',
      ),
    ).resolves.toMatchObject({ revision: 1 });
    expect(createVersion).not.toHaveBeenCalled();
  });

  it('wins pointer CAS before inserting the next immutable version', async () => {
    const current = persistedInstallation();
    const winner = persistedInstallation(
      persistedVersion({
        id: 'version-2',
        revision: 2,
        definitionVersion: 2,
        configuration: { tone: 'warm', count: 4 },
      }),
    );
    const switchPointer = jest.fn<
      (input: unknown) => Promise<{ count: number }>
    >(() => Promise.resolve({ count: 1 }));
    const createVersion = jest.fn<(input: unknown) => Promise<{ id: string }>>(
      () => Promise.resolve({ id: 'ignored' }),
    );
    const tx = {
      organizationAgentInstallation: {
        findFirst: jest.fn(() => Promise.resolve(current)),
        updateMany: switchPointer,
        findUniqueOrThrow: jest.fn(() => Promise.resolve(winner)),
      },
      organizationAgentVersion: { create: createVersion },
    };
    const prisma = {
      $transaction: jest.fn((operation: (client: typeof tx) => unknown) =>
        operation(tx),
      ),
    } as unknown as PrismaService;
    const service = new OrganizationAgentInstallationService(
      prisma,
      registry(),
    );

    await expect(
      service.replace(
        'org-1',
        'installation-1',
        {
          expectedRevision: 1,
          definitionVersion: 2,
          enabled: true,
          configuration: { tone: 'warm', count: 4 },
        },
        'actor-1',
      ),
    ).resolves.toMatchObject({ revision: 2 });

    const switchInput = switchPointer.mock.calls.at(0)?.[0];
    if (switchInput === undefined)
      throw new Error('pointer CAS was not called');
    const candidateId = (switchInput as { data: { activeVersionId: string } })
      .data.activeVersionId;
    expect(createVersion).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: candidateId,
        installationId: 'installation-1',
        revision: 2,
        modelPolicyId: configurableV2.modelPolicy.id,
        modelId: MODEL_IDS.openAiGpt4oMini,
      }),
      select: { id: true },
    });
    const switchOrder = switchPointer.mock.invocationCallOrder.at(0);
    const createOrder = createVersion.mock.invocationCallOrder.at(0);
    if (switchOrder === undefined || createOrder === undefined) {
      throw new Error('expected both pointer CAS and version insert');
    }
    expect(switchOrder).toBeLessThan(createOrder);
  });

  it('treats a stale request matching the winner as an idempotent success', async () => {
    const before = persistedInstallation();
    const winner = persistedInstallation(
      persistedVersion({
        id: 'version-2',
        revision: 2,
        definitionVersion: 2,
        configuration: { count: 4, tone: 'warm' },
      }),
    );
    const tx = {
      organizationAgentInstallation: {
        findFirst: jest.fn(() => Promise.resolve(before)),
        updateMany: jest.fn(() => Promise.resolve({ count: 0 })),
      },
      organizationAgentVersion: {
        create: jest.fn(() => Promise.resolve({ id: 'loser-version' })),
      },
    };
    const prisma = {
      $transaction: jest.fn((operation: (client: typeof tx) => unknown) =>
        operation(tx),
      ),
      organizationAgentInstallation: {
        findFirst: jest.fn(() => Promise.resolve(winner)),
      },
    } as unknown as PrismaService;
    const service = new OrganizationAgentInstallationService(
      prisma,
      registry(),
    );

    await expect(
      service.replace(
        'org-1',
        'installation-1',
        {
          expectedRevision: 1,
          definitionVersion: 2,
          enabled: true,
          configuration: { tone: 'warm', count: 4 },
        },
        'actor-1',
      ),
    ).resolves.toMatchObject({ revision: 2, activeVersionId: 'version-2' });
    expect(tx.organizationAgentVersion.create).not.toHaveBeenCalled();
  });

  it('reports a stale different winner as a conflict', async () => {
    const current = persistedInstallation();
    const prisma = {
      $transaction: jest.fn(() =>
        Promise.reject(Object.assign(new Error(), { name: 'unreachable' })),
      ),
      organizationAgentInstallation: {
        findFirst: jest.fn(() => Promise.resolve(current)),
      },
    } as unknown as PrismaService;
    const service = new OrganizationAgentInstallationService(
      prisma,
      registry(),
    );

    // Exercise the public conflict path with an expected revision that differs
    // inside the transaction rather than coupling the test to its private error.
    (
      prisma.$transaction as jest.MockedFunction<PrismaService['$transaction']>
    ).mockImplementation(async (operation: never) => {
      const tx = {
        organizationAgentInstallation: {
          findFirst: jest.fn(() => Promise.resolve(current)),
        },
      };
      return (operation as (client: typeof tx) => Promise<never>)(tx);
    });

    await expect(
      service.replace(
        'org-1',
        'installation-1',
        {
          expectedRevision: 9,
          definitionVersion: 2,
          enabled: true,
          configuration: { tone: 'warm', count: 4 },
        },
        'actor-1',
      ),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      publicDetails: { reason: 'stale_revision' },
    });
  });
});
