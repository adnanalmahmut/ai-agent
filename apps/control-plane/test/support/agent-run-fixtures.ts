import { z } from 'zod';

import { AgentDefinitionRegistry } from '../../src/ai/agents/agent-definition.registry';
import type { AgentDefinition } from '../../src/ai/agents/agent.types';
import type { PrismaService } from '../../src/infrastructure/database';
import { MODEL_IDS } from '../../src/ai/models/model-catalog';

export const TEST_AGENT_ID = 'test-only-agent';

const definition = (version: number): AgentDefinition => ({
  id: TEST_AGENT_ID,
  version,
  runtime: 'mastra',
  instructions: `Test-only agent revision ${version}.`,
  model: MODEL_IDS.openAiGpt4oMini,
  modelPolicy: {
    id: `${TEST_AGENT_ID}.model-policy.${version}`,
    allowedModelIds: [MODEL_IDS.openAiGpt4oMini],
  },
  input: z.unknown(),
  output: z.unknown(),
  organizationConfiguration: {
    schema: z.object({ marker: z.string().default('default') }).strict(),
    defaultValue: { marker: 'default' },
  },
});

/**
 * A revision whose output schema actually normalises, so a suite can prove
 * that what reaches the database is what the pinned definition made of a
 * result rather than what arrived on the wire.
 *
 * Its own revision on purpose: revisions 1 and 2 accept arbitrary output, and
 * several suites depend on that, so tightening them to test normalisation
 * would change what those suites are testing.
 */
const normalisingDefinition = (): AgentDefinition => ({
  ...definition(3),
  output: z.object({
    answer: z.string().trim(),
    sources: z.array(z.string()).default([]),
  }),
});

export const TEST_AGENT_DEFINITIONS = [
  definition(1),
  definition(2),
  normalisingDefinition(),
] as const;

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
        modelPolicyId: `${TEST_AGENT_ID}.model-policy.${definitionVersion}`,
        modelId: MODEL_IDS.openAiGpt4oMini,
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
  options: {
    enabled?: boolean;
    configuration?: unknown;
    legacyModelPin?: boolean;
  } = {},
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
        modelPolicyId: options.legacyModelPin
          ? null
          : `${TEST_AGENT_ID}.model-policy.${definitionVersion}`,
        modelId: options.legacyModelPin ? null : MODEL_IDS.openAiGpt4oMini,
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
