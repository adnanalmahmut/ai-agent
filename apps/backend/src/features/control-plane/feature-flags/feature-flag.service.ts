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

/** Where a resolved value came from, so an operator can see why it is what it is. */
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

/**
 * Whether a feature accepts new work.
 *
 * ## Precedence
 *
 * Organization override, then platform override, then the code default. Stated
 * once here and nowhere else, because the failure mode of a duplicated
 * precedence rule is a feature that is off in the Platform and on in the API.
 *
 * ## Why nothing is cached
 *
 * Every evaluation is a query. That is a deliberate cost, not an oversight:
 * the semantic this slice promises is that disabling a feature stops acceptance
 * of new work *immediately*, and any cache turns "immediately" into "within the
 * TTL". An operator disabling a feature is usually doing it because something
 * is wrong, which is exactly when a stale read is least acceptable.
 *
 * The cost is one indexed lookup on a table with as many rows as there are
 * flags. If that ever matters, the answer is a cache with explicit invalidation
 * on write, not a TTL — but there is no evidence it matters.
 *
 * ## What it does not do
 *
 * It never cancels accepted work. A disabled flag refuses new requests; an
 * AgentRun that was already accepted keeps its durable contract and runs to
 * completion. Hard cancellation is a separate feature with its own semantics,
 * and quietly killing in-flight work through a flag would make a durable
 * accepted state a lie.
 */
@Injectable()
export class FeatureFlagService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: ControlPlaneAuditService,
  ) {}

  /**
   * Resolves one flag.
   *
   * `organizationId` is optional because some callers are platform-scoped. When
   * absent the organization tier is simply not consulted — it is not treated as
   * "no override", which would be the same answer by accident rather than by
   * intent.
   */
  async isEnabled(
    key: FeatureFlagKey,
    scope: { organizationId?: string } = {},
  ): Promise<boolean> {
    const state = await this.resolve(key, scope);

    return state.enabled;
  }

  /**
   * Refuses the request unless the flag is on.
   *
   * A single call site for the gate, so every feature refuses the same way and
   * a caller cannot accidentally evaluate the flag and then ignore it. The
   * error carries the key as internal context only — a caller learns that the
   * feature is unavailable, not which internal switch controls it.
   */
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
      /**
       * Not consulted when the flag is not organization-scoped, even if rows
       * exist. `setOrganizationOverride` refuses to write them, but a flag can
       * be narrowed in code after overrides were already stored, and honouring
       * a row the registry now forbids would make the registry's declaration
       * false. The stale rows are left in place rather than deleted: widening
       * the flag again should restore what an operator configured.
       */
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

  /**
   * Refuses an organization that does not exist.
   *
   * Without it the two organization-addressed surfaces disagree with each
   * other and with the key handling beside them: a write would reach the
   * database and come back as a foreign-key violation, which has no mapping
   * and so becomes a 500 with a stack trace, while a read would answer 200
   * with a complete, entirely fabricated resolution for an organization that
   * is not there. An unknown organization is a 404 for the same reason an
   * unknown flag key is.
   */
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

  /** Every flag with its resolved value, for the control-plane read surface. */
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
    /**
     * The override and its audit row commit together.
     *
     * Read-before-write inside the transaction, because the audit entry records
     * what the override *was* and reading it outside would be reading a value
     * another operator may already have replaced — attributing their change to
     * this one.
     */
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

  /**
   * Removing an override is distinct from setting it to the default value.
   *
   * They look identical today and stop being identical the moment the code
   * default changes: a cleared flag follows the new default, a flag pinned to
   * the old value does not. Operators need to be able to express both.
   */
  async clearPlatformOverride(input: {
    key: FeatureFlagKey;
    actorUserId: string;
  }): Promise<FeatureFlagState> {
    /**
     * Clearing is exactly the case a `updatedByUserId` column cannot record:
     * the row that carried the attribution is the row being deleted, so without
     * this the fact that somebody removed an override — and what it was —
     * leaves no trace anywhere.
     */
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.featureFlagPlatformOverride.findUnique({
        where: { key: input.key },
        select: { enabled: true },
      });

      await tx.featureFlagPlatformOverride.deleteMany({
        where: { key: input.key },
      });

      /**
       * Nothing stored means nothing was cleared, and an append-only history
       * must not carry an event for a change that did not happen. The Platform
       * disables the button when there is no override, but the API is the
       * authority and has no such guard — a script, or a double-click that
       * races the disabled state, reaches here with `before` already null.
       */
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
      /**
       * Refused on write rather than ignored on read. A stored override the
       * evaluator silently skipped would show one value in the Platform and
       * behave as another, which is the worst available outcome for a
       * mechanism whose whole job is to be believed.
       */
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

/** An override row as the audit log records it, or null when there was none. */
function overrideState(
  row: { enabled: boolean } | null,
): ControlPlaneAuditState | null {
  return row === null
    ? null
    : { kind: 'featureFlagOverride', enabled: row.enabled };
}
