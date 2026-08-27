import { z } from 'zod';

import { AgentDefinitionRegistry } from '../../src/agents/agent-definition.registry';
import type { AgentDefinition } from '../../src/agents/agent.types';
import type { PrismaService } from '../../src/database';

export const TEST_AGENT_ID = 'test-only-agent';

const definition = (version: number): AgentDefinition => ({
  id: TEST_AGENT_ID,
  version,
  runtime: 'mastra',
  instructions: `Test-only agent revision ${version}.`,
  model: 'test/model',
  input: z.unknown(),
  output: z.unknown(),
  organizationConfiguration: {
    schema: z.object({ marker: z.string().default('default') }).strict(),
    defaultValue: { marker: 'default' },
  },
});

export const TEST_AGENT_DEFINITIONS = [definition(1), definition(2)] as const;

export const testAgentRegistry = () =>
  new AgentDefinitionRegistry(TEST_AGENT_DEFINITIONS);

export async function installTestAgent(
  prisma: PrismaService,
  organizationId: string,
  definitionVersion = 1,
) {
  return prisma.$transaction(async (tx) => {
    const installation = await tx.organizationAgentInstallation.create({
      data: { organizationId, agentId: TEST_AGENT_ID },
      select: { id: true },
    });
    const version = await tx.organizationAgentVersion.create({
      data: {
        organizationId,
        installationId: installation.id,
        revision: 1,
        definitionVersion,
        enabled: true,
        configuration: {},
      },
      select: { id: true },
    });
    await tx.organizationAgentInstallation.update({
      where: { id: installation.id },
      data: { revision: 1, activeVersionId: version.id },
    });
    return { installationId: installation.id, versionId: version.id };
  });
}

export async function activateTestAgentVersion(
  prisma: PrismaService,
  organizationId: string,
  definitionVersion: number,
  options: { enabled?: boolean; configuration?: unknown } = {},
) {
  return prisma.$transaction(async (tx) => {
    const installation =
      await tx.organizationAgentInstallation.findUniqueOrThrow({
        where: {
          organizationId_agentId: {
            organizationId,
            agentId: TEST_AGENT_ID,
          },
        },
        select: { id: true, revision: true },
      });
    const revision = installation.revision + 1;
    const version = await tx.organizationAgentVersion.create({
      data: {
        organizationId,
        installationId: installation.id,
        revision,
        definitionVersion,
        enabled: options.enabled ?? true,
        configuration: (options.configuration ?? {}) as never,
      },
      select: { id: true },
    });
    await tx.organizationAgentInstallation.update({
      where: { id: installation.id },
      data: { revision, activeVersionId: version.id },
    });
    return { installationId: installation.id, versionId: version.id, revision };
  });
}

export async function cleanTestAgentInstallations(
  prisma: PrismaService,
  organizationIds: readonly string[],
) {
  const where = { organizationId: { in: [...organizationIds] } };
  await prisma.organizationAgentInstallation.updateMany({
    where: { ...where, agentId: TEST_AGENT_ID },
    data: { activeVersionId: null },
  });
  await prisma.organizationAgentVersion.deleteMany({
    where: {
      ...where,
      installation: { agentId: TEST_AGENT_ID },
    },
  });
  await prisma.organizationAgentInstallation.deleteMany({
    where: { ...where, agentId: TEST_AGENT_ID },
  });
}
