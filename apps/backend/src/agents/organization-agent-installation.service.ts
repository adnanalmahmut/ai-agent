import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ZodError } from 'zod';

import { AppException } from '../core/errors';
import { PrismaService } from '../database';
import { Prisma } from '../generated/prisma/client';
import { isAgentConfigurationError } from './agent-configuration.error';
import { AgentDefinitionRegistry } from './agent-definition.registry';
import type { AgentConfiguration } from './agent.types';
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
  enabled: true,
  configuration: true,
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
      defaultConfiguration: this.definitions.parseOrganizationConfiguration(
        definition.id,
        definition.version,
        undefined,
      ),
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
            enabled: input.enabled,
            configuration: asJson(configuration),
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
          enabled: input.enabled,
          configuration: this.parseConfiguration(
            current.agentId,
            input.definitionVersion,
            input.configuration,
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
            enabled: desired.enabled,
            configuration: asJson(desired.configuration),
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
}

type DesiredVersion = {
  definitionVersion: number;
  enabled: boolean;
  configuration: AgentConfiguration;
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
    configuration: version.configuration as AgentConfiguration,
  };
}

function matches(
  version: OrganizationAgentVersion | PersistedVersion,
  desired: DesiredVersion,
) {
  return (
    version.definitionVersion === desired.definitionVersion &&
    version.enabled === desired.enabled &&
    isDeepStrictEqual(version.configuration, desired.configuration)
  );
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
