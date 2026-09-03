import { Injectable } from '@nestjs/common';

import { AppException } from '../../../core/errors';
import { PrismaService } from '../../../infrastructure/database';
import {
  ControlPlaneAuditService,
  type ControlPlaneAuditState,
} from '../audit/control-plane-audit.service';
import {
  FEATURE_FLAGS,
  FEATURE_FLAG_KEYS,
  type FeatureFlagKey,
  featureFlagDefinition,
} from './feature-flag.registry';

export type FeatureFlagSource = 'organization' | 'platform' | 'default';

export type FeatureFlagState = {
  key: FeatureFlagKey;
  description: string;
  enabled: boolean;
  source: FeatureFlagSource;
  defaultEnabled: boolean;
  platformOverride: boolean | undefined;
  organizationOverride: boolean | undefined;
  organizationOverridable: boolean;
};

@Injectable()
export class FeatureFlagService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: ControlPlaneAuditService,
  ) {}

  async isEnabled(
    key: FeatureFlagKey,
    scope: { organizationId?: string } = {},
  ): Promise<boolean> {
    const state = await this.resolve(key, scope);

    return state.enabled;
  }

  async assertEnabled(
    key: FeatureFlagKey,
    scope: { organizationId?: string } = {},
  ): Promise<void> {
    if (await this.isEnabled(key, scope)) return;

    throw new AppException('FEATURE_DISABLED', {
      context: { featureFlag: key, ...scope },
    });
  }

  async resolve(
    key: FeatureFlagKey,
    scope: { organizationId?: string } = {},
  ): Promise<FeatureFlagState> {
    const definition = featureFlagDefinition(key);

    const [platform, organization] = await Promise.all([
      this.prisma.featureFlagPlatformOverride.findUnique({
        where: { key },
        select: { enabled: true },
      }),
      scope.organizationId === undefined || !definition.organizationOverridable
        ? Promise.resolve(null)
        : this.prisma.featureFlagOrganizationOverride.findUnique({
            where: {
              organizationId_key: { organizationId: scope.organizationId, key },
            },
            select: { enabled: true },
          }),
    ]);

    const resolved =
      organization !== null
        ? { enabled: organization.enabled, source: 'organization' as const }
        : platform !== null
          ? { enabled: platform.enabled, source: 'platform' as const }
          : { enabled: definition.defaultEnabled, source: 'default' as const };

    return {
      key,
      description: definition.description,
      enabled: resolved.enabled,
      source: resolved.source,
      defaultEnabled: definition.defaultEnabled,
      platformOverride: platform?.enabled,
      organizationOverride: organization?.enabled,
      organizationOverridable: definition.organizationOverridable,
    };
  }

  private async assertOrganizationExists(
    organizationId: string,
  ): Promise<void> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });

    if (organization === null) {
      throw new AppException('NOT_FOUND', {
        context: { resource: 'organization', organizationId },
      });
    }
  }

  async listAll(
    scope: { organizationId?: string } = {},
  ): Promise<FeatureFlagState[]> {
    if (scope.organizationId !== undefined) {
      await this.assertOrganizationExists(scope.organizationId);
    }

    return Promise.all(
      FEATURE_FLAG_KEYS.map((key) => this.resolve(key, scope)),
    );
  }

  async setPlatformOverride(input: {
    key: FeatureFlagKey;
    enabled: boolean;
    actorUserId: string;
  }): Promise<FeatureFlagState> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.featureFlagPlatformOverride.findUnique({
        where: { key: input.key },
        select: { enabled: true },
      });

      await tx.featureFlagPlatformOverride.upsert({
        where: { key: input.key },
        create: {
          key: input.key,
          enabled: input.enabled,
          updatedByUserId: input.actorUserId,
        },
        update: {
          enabled: input.enabled,
          updatedByUserId: input.actorUserId,
        },
      });

      await this.audit.record(tx, {
        action: 'featureFlag.setPlatformOverride',
        resourceKey: input.key,
        actorUserId: input.actorUserId,
        before: overrideState(before),
        after: { kind: 'featureFlagOverride', enabled: input.enabled },
      });
    });

    return this.resolve(input.key);
  }

  async clearPlatformOverride(input: {
    key: FeatureFlagKey;
    actorUserId: string;
  }): Promise<FeatureFlagState> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.featureFlagPlatformOverride.findUnique({
        where: { key: input.key },
        select: { enabled: true },
      });

      await tx.featureFlagPlatformOverride.deleteMany({
        where: { key: input.key },
      });

      if (before === null) return;

      await this.audit.record(tx, {
        action: 'featureFlag.clearPlatformOverride',
        resourceKey: input.key,
        actorUserId: input.actorUserId,
        before: overrideState(before),
        after: null,
      });
    });

    return this.resolve(input.key);
  }

  async setOrganizationOverride(input: {
    key: FeatureFlagKey;
    organizationId: string;
    enabled: boolean;
    actorUserId: string;
  }): Promise<FeatureFlagState> {
    if (!FEATURE_FLAGS[input.key].organizationOverridable) {
      throw new AppException('BAD_REQUEST', {
        context: { featureFlag: input.key, reason: 'not_organization_scoped' },
      });
    }

    await this.assertOrganizationExists(input.organizationId);

    await this.prisma.$transaction(async (tx) => {
      const before = await tx.featureFlagOrganizationOverride.findUnique({
        where: {
          organizationId_key: {
            organizationId: input.organizationId,
            key: input.key,
          },
        },
        select: { enabled: true },
      });

      await tx.featureFlagOrganizationOverride.upsert({
        where: {
          organizationId_key: {
            organizationId: input.organizationId,
            key: input.key,
          },
        },
        create: {
          key: input.key,
          organizationId: input.organizationId,
          enabled: input.enabled,
          updatedByUserId: input.actorUserId,
        },
        update: { enabled: input.enabled, updatedByUserId: input.actorUserId },
      });

      await this.audit.record(tx, {
        action: 'featureFlag.setOrganizationOverride',
        resourceKey: input.key,
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        before: overrideState(before),
        after: { kind: 'featureFlagOverride', enabled: input.enabled },
      });
    });

    return this.resolve(input.key, { organizationId: input.organizationId });
  }

  async clearOrganizationOverride(input: {
    key: FeatureFlagKey;
    organizationId: string;
    actorUserId: string;
  }): Promise<FeatureFlagState> {
    await this.assertOrganizationExists(input.organizationId);

    await this.prisma.$transaction(async (tx) => {
      const before = await tx.featureFlagOrganizationOverride.findUnique({
        where: {
          organizationId_key: {
            organizationId: input.organizationId,
            key: input.key,
          },
        },
        select: { enabled: true },
      });

      await tx.featureFlagOrganizationOverride.deleteMany({
        where: { organizationId: input.organizationId, key: input.key },
      });

      // Same no-op as the platform clear above: no stored override, no event.
      if (before === null) return;

      await this.audit.record(tx, {
        action: 'featureFlag.clearOrganizationOverride',
        resourceKey: input.key,
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        before: overrideState(before),
        after: null,
      });
    });

    return this.resolve(input.key, { organizationId: input.organizationId });
  }
}

function overrideState(
  row: { enabled: boolean } | null,
): ControlPlaneAuditState | null {
  return row === null
    ? null
    : { kind: 'featureFlagOverride', enabled: row.enabled };
}
