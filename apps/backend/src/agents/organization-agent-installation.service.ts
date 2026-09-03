import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ZodError } from 'zod';

import { AppException } from '../core/errors';
import { PrismaService } from '../infrastructure/database';
import { Prisma } from '../generated/prisma/client';
import { isAgentConfigurationError } from '../ai/agents/agent-configuration.error';
import { AgentDefinitionRegistry } from '../ai/agents/agent-definition.registry';
import type { AgentConfiguration } from '../ai/agents/agent.types';
import type { AgentDefinition } from '../ai/agents/agent.types';
import type { ToolRef } from '../ai/tools/tool.types';
import {
  APPLICATION_MODEL_CATALOG,
  type AgentModelId,
} from '../ai/models/model-catalog';
import type {
  CreateOrganizationAgentInstallation,
  OrganizationAgentCatalogEntry,
  OrganizationAgentInstallation,
  OrganizationAgentVersion,
  ReplaceOrganizationAgentInstallation,
} from './organization-agent-installation.types';

const versionSelect = {
  id: true,
  organizationId: true,
  installationId: true,
  revision: true,
  definitionVersion: true,
  modelPolicyId: true,
  modelId: true,
  enabled: true,
  configuration: true,
  toolGrants: true,
  createdByUserId: true,
  createdAt: true,
} as const;

const installationSelect = {
  id: true,
  organizationId: true,
  agentId: true,
  revision: true,
  activeVersionId: true,
  activeVersion: { select: versionSelect },
  createdAt: true,
  updatedAt: true,
} as const;

type PersistedInstallation = Prisma.OrganizationAgentInstallationGetPayload<{
  select: typeof installationSelect;
}>;

type PersistedVersion = Prisma.OrganizationAgentVersionGetPayload<{
  select: typeof versionSelect;
}>;

export const ORGANIZATION_AGENT_VERSION_PAGE_SIZE = 25;
export const MAX_ORGANIZATION_AGENT_VERSION_PAGE_SIZE = 100;

class InstallationPointerConflict extends Error {}

@Injectable()
export class OrganizationAgentInstallationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly definitions: AgentDefinitionRegistry,
  ) {}

  catalog(): OrganizationAgentCatalogEntry[] {
    return this.definitions.listInstallable().map((definition) => ({
      agentId: definition.id,
      latestDefinitionVersion: definition.version,
      modelPolicyId: definition.modelPolicy.id,
      defaultModelId: definition.model,
      allowedModelIds: [...definition.modelPolicy.allowedModelIds],
      defaultConfiguration: this.definitions.parseOrganizationConfiguration(
        definition.id,
        definition.version,
        undefined,
      ),
      maxToolGrants: [...(definition.maxToolGrants ?? [])],
    }));
  }

  async list(organizationId: string): Promise<OrganizationAgentInstallation[]> {
    const rows = await this.prisma.organizationAgentInstallation.findMany({
      where: { organizationId },
      orderBy: { agentId: 'asc' },
      select: installationSelect,
    });

    return rows.map(toInstallation);
  }

  async create(
    organizationId: string,
    input: CreateOrganizationAgentInstallation,
    actorUserId: string,
  ): Promise<OrganizationAgentInstallation> {
    const configuration = this.parseConfiguration(
      input.agentId,
      input.definitionVersion,
      input.configuration,
    );
    const model = this.selectModel(
      input.agentId,
      input.definitionVersion,
      input.modelId,
    );
    const toolGrants = this.selectToolGrants(
      input.agentId,
      input.definitionVersion,
      input.toolGrants,
    );

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const installation = await tx.organizationAgentInstallation.create({
          data: { organizationId, agentId: input.agentId },
          select: { id: true },
        });

        const version = await tx.organizationAgentVersion.create({
          data: {
            organizationId,
            installationId: installation.id,
            revision: 1,
            definitionVersion: input.definitionVersion,
            modelPolicyId: model.policyId,
            modelId: model.modelId,
            enabled: input.enabled,
            configuration: asJson(configuration),
            toolGrants,
            createdByUserId: actorUserId,
          },
          select: { id: true },
        });

        await tx.organizationAgentInstallation.update({
          where: { id: installation.id },
          data: { revision: 1, activeVersionId: version.id },
        });

        return tx.organizationAgentInstallation.findUniqueOrThrow({
          where: { id: installation.id },
          select: installationSelect,
        });
      });

      return toInstallation(row);
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;

      throw new AppException('CONFLICT', {
        context: { resource: 'organizationAgentInstallation' },
        publicDetails: { reason: 'already_installed' },
      });
    }
  }

  async replace(
    organizationId: string,
    installationId: string,
    input: ReplaceOrganizationAgentInstallation,
    actorUserId: string,
  ): Promise<OrganizationAgentInstallation> {
    let desired: DesiredVersion | null = null;

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const current = await tx.organizationAgentInstallation.findFirst({
          where: { id: installationId, organizationId },
          select: installationSelect,
        });

        if (!current) throw installationNotFound();
        const currentVersion = requireActiveVersion(current);

        desired = {
          definitionVersion: input.definitionVersion,
          ...this.selectModel(
            current.agentId,
            input.definitionVersion,
            input.modelId,
          ),
          enabled: input.enabled,
          configuration: this.parseConfiguration(
            current.agentId,
            input.definitionVersion,
            input.configuration,
          ),
          toolGrants: this.selectToolGrants(
            current.agentId,
            input.definitionVersion,
            input.toolGrants,
          ),
        };

        if (matches(currentVersion, desired)) return current;

        if (current.revision !== input.expectedRevision) {
          throw new InstallationPointerConflict();
        }

        const candidateId = randomUUID();

        const switched = await tx.organizationAgentInstallation.updateMany({
          where: {
            id: installationId,
            organizationId,
            revision: input.expectedRevision,
            activeVersionId: currentVersion.id,
          },
          data: {
            revision: { increment: 1 },
            activeVersionId: candidateId,
          },
        });

        // The deferred active-pointer FK lets CAS run before candidate insert.
        // A loser therefore writes no candidate; a later insert failure rolls
        // this pointer change back with the transaction.
        if (switched.count !== 1) throw new InstallationPointerConflict();

        await tx.organizationAgentVersion.create({
          data: {
            id: candidateId,
            organizationId,
            installationId,
            revision: current.revision + 1,
            definitionVersion: desired.definitionVersion,
            modelPolicyId: desired.policyId,
            modelId: desired.modelId,
            enabled: desired.enabled,
            configuration: asJson(desired.configuration),
            toolGrants: desired.toolGrants,
            createdByUserId: actorUserId,
          },
          select: { id: true },
        });

        return tx.organizationAgentInstallation.findUniqueOrThrow({
          where: { id: installationId },
          select: installationSelect,
        });
      });

      return toInstallation(row);
    } catch (error) {
      if (!(error instanceof InstallationPointerConflict)) throw error;

      const latest = await this.find(organizationId, installationId);
      if (desired && matches(latest.activeVersion, desired)) return latest;

      throw new AppException('CONFLICT', {
        context: { resource: 'organizationAgentInstallation' },
        publicDetails: { reason: 'stale_revision' },
      });
    }
  }

  async listVersions(input: {
    organizationId: string;
    installationId: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    items: OrganizationAgentVersion[];
    nextCursor: string | null;
  }> {
    await this.find(input.organizationId, input.installationId);
    const take = versionPageSize(input.limit);
    const after = input.cursor ? decodeCursor(input.cursor) : null;

    const rows = await this.prisma.organizationAgentVersion.findMany({
      where: {
        organizationId: input.organizationId,
        installationId: input.installationId,
        ...(after ? beforePosition(after) : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      select: versionSelect,
    });

    const items = rows.slice(0, take).map(toVersion);
    const last = items.at(-1);

    return {
      items,
      nextCursor:
        rows.length > take && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  private async find(
    organizationId: string,
    installationId: string,
  ): Promise<OrganizationAgentInstallation> {
    const row = await this.prisma.organizationAgentInstallation.findFirst({
      where: { id: installationId, organizationId },
      select: installationSelect,
    });
    if (!row) throw installationNotFound();
    return toInstallation(row);
  }

  private parseConfiguration(
    agentId: string,
    definitionVersion: number,
    value: unknown,
  ): AgentConfiguration {
    try {
      return this.definitions.parseOrganizationConfiguration(
        agentId,
        definitionVersion,
        value,
      );
    } catch (error) {
      if (isAgentConfigurationError(error)) {
        throw new AppException('NOT_FOUND', {
          context: { resource: 'agentDefinition' },
        });
      }
      if (error instanceof ZodError) {
        throw new AppException('VALIDATION_ERROR', {
          context: {
            resource: 'organizationAgentConfiguration',
            reason: 'schema',
          },
          publicDetails: { reason: 'invalid_configuration' },
        });
      }
      throw error;
    }
  }

  private selectModel(
    agentId: string,
    definitionVersion: number,
    requested: string | undefined,
  ): { policyId: string; modelId: AgentModelId } {
    let definition: AgentDefinition;
    try {
      definition = this.definitions.resolve(agentId, definitionVersion);
    } catch (error) {
      if (isAgentConfigurationError(error)) {
        throw new AppException('NOT_FOUND', {
          context: { resource: 'agentDefinition' },
        });
      }
      throw error;
    }

    const selected = requested ?? definition.model;
    if (
      !definition.modelPolicy.allowedModelIds.includes(selected as AgentModelId)
    ) {
      throw invalidModelSelection();
    }
    try {
      APPLICATION_MODEL_CATALOG.agentModel(selected);
    } catch {
      throw invalidModelSelection();
    }
    return {
      policyId: definition.modelPolicy.id,
      modelId: selected as AgentModelId,
    };
  }

  /**
   * The organization's selection, narrowed to what the definition permits.
   *
   * Narrowed, never widened: the maximum belongs to the code-owned revision,
   * and a tenant that could add to it would be granting itself capability. A
   * request naming a tool outside the maximum is refused rather than trimmed,
   * because silently dropping it would report success for a selection that was
   * not honoured.
   *
   * Omitted means none. That is what makes the whole feature additive: an
   * existing client that has never heard of tools keeps creating versions with
   * no grants, which is exactly what every version created before this existed
   * already means.
   */
  private selectToolGrants(
    agentId: string,
    definitionVersion: number,
    requested: readonly ToolRef[] | undefined,
  ): ToolRef[] {
    if (requested === undefined || requested.length === 0) return [];

    let definition: AgentDefinition;
    try {
      definition = this.definitions.resolve(agentId, definitionVersion);
    } catch (error) {
      if (isAgentConfigurationError(error)) {
        throw new AppException('NOT_FOUND', {
          context: { resource: 'agentDefinition' },
        });
      }
      throw error;
    }

    const maximum = new Set(definition.maxToolGrants ?? []);
    const selected = new Set<ToolRef>();

    for (const ref of requested) {
      // A duplicate is refused rather than collapsed. The request says
      // something the caller did not mean, and answering a different question
      // than the one asked is how a client stays wrong for a long time.
      if (selected.has(ref)) throw invalidToolSelection('duplicate_tool');
      if (!maximum.has(ref)) throw invalidToolSelection('tool_not_permitted');
      selected.add(ref);
    }

    /**
     * Sorted, so the stored value is canonical.
     *
     * Grant identity is a set, but the column is an array. Without a canonical
     * order, the same selection sent in a different order would compare
     * unequal to the active version and publish a new immutable revision that
     * differs from its predecessor in nothing but ordering.
     */
    return [...selected].sort();
  }
}

function invalidToolSelection(reason: string): AppException {
  return new AppException('VALIDATION_ERROR', {
    context: { resource: 'organizationAgentToolGrants', reason },
    publicDetails: { reason },
  });
}

type DesiredVersion = {
  definitionVersion: number;
  policyId: string;
  modelId: AgentModelId;
  enabled: boolean;
  configuration: AgentConfiguration;
  toolGrants: ToolRef[];
};

function requireActiveVersion(
  installation: PersistedInstallation,
): PersistedVersion {
  if (!installation.activeVersionId || !installation.activeVersion) {
    throw new Error('Organization agent installation has no active version');
  }
  return installation.activeVersion;
}

function toInstallation(
  installation: PersistedInstallation,
): OrganizationAgentInstallation {
  const activeVersion = requireActiveVersion(installation);
  return {
    id: installation.id,
    organizationId: installation.organizationId,
    agentId: installation.agentId,
    revision: installation.revision,
    activeVersionId: activeVersion.id,
    activeVersion: toVersion(activeVersion),
    createdAt: installation.createdAt,
    updatedAt: installation.updatedAt,
  };
}

function toVersion(version: PersistedVersion): OrganizationAgentVersion {
  return {
    ...version,
    modelId: version.modelId as AgentModelId | null,
    toolGrants: version.toolGrants as ToolRef[],
    configuration: version.configuration as AgentConfiguration,
  };
}

function matches(
  version: OrganizationAgentVersion | PersistedVersion,
  desired: DesiredVersion,
) {
  return (
    version.definitionVersion === desired.definitionVersion &&
    version.modelPolicyId === desired.policyId &&
    version.modelId === desired.modelId &&
    version.enabled === desired.enabled &&
    // Grants are part of what a version *is*. Omitting them here would make a
    // grant-only change a silent no-op that reported success.
    isDeepStrictEqual([...version.toolGrants], desired.toolGrants) &&
    isDeepStrictEqual(version.configuration, desired.configuration)
  );
}

function invalidModelSelection(): AppException {
  return new AppException('VALIDATION_ERROR', {
    context: { resource: 'organizationAgentModel', reason: 'policy' },
    publicDetails: { reason: 'invalid_model_selection' },
  });
}

function asJson(configuration: AgentConfiguration): Prisma.InputJsonValue {
  return configuration;
}

function installationNotFound(): AppException {
  return new AppException('NOT_FOUND', {
    context: { resource: 'organizationAgentInstallation' },
  });
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

type VersionCursor = { createdAt: Date; id: string };

function versionPageSize(requested: number | undefined): number {
  if (requested === undefined) return ORGANIZATION_AGENT_VERSION_PAGE_SIZE;
  if (
    !Number.isInteger(requested) ||
    requested < 1 ||
    requested > MAX_ORGANIZATION_AGENT_VERSION_PAGE_SIZE
  ) {
    throw new AppException('VALIDATION_ERROR', {
      context: { resource: 'organizationAgentVersion', reason: 'limit' },
      publicDetails: {
        reason: `A page size must be a whole number between 1 and ${MAX_ORGANIZATION_AGENT_VERSION_PAGE_SIZE}.`,
      },
    });
  }
  return requested;
}

function beforePosition(after: VersionCursor) {
  return {
    OR: [
      { createdAt: { lt: after.createdAt } },
      { createdAt: after.createdAt, id: { lt: after.id } },
    ],
  };
}

function encodeCursor(cursor: VersionCursor): string {
  return Buffer.from(
    JSON.stringify({ at: cursor.createdAt.toISOString(), id: cursor.id }),
    'utf8',
  ).toString('base64url');
}

function decodeCursor(value: string): VersionCursor {
  const invalid = () =>
    new AppException('VALIDATION_ERROR', {
      context: { resource: 'organizationAgentVersion', reason: 'cursor' },
      publicDetails: { reason: 'The page cursor is not readable.' },
    });

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (!parsed || typeof parsed !== 'object') throw invalid();
  const { at, id } = parsed as Record<string, unknown>;
  if (
    typeof at !== 'string' ||
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > 120
  ) {
    throw invalid();
  }
  const createdAt = new Date(at);
  if (Number.isNaN(createdAt.getTime())) throw invalid();
  return { createdAt, id };
}
