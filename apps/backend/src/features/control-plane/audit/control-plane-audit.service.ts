import { Injectable } from '@nestjs/common';

import { AppException } from '../../../core/errors';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../infrastructure/database';

export const CONTROL_PLANE_AUDIT_ACTIONS = [
  'featureFlag.setPlatformOverride',
  'featureFlag.clearPlatformOverride',
  'featureFlag.setOrganizationOverride',
  'featureFlag.clearOrganizationOverride',
  'runtimeSetting.set',
  'runtimeSetting.reset',
  'managedSecret.configure',
  'managedSecret.rotate',
  'managedSecret.remove',
  'managedSecret.reencrypt',
] as const;

export type ControlPlaneAuditAction =
  (typeof CONTROL_PLANE_AUDIT_ACTIONS)[number];

export const CONTROL_PLANE_AUDIT_RESOURCES = [
  'featureFlag',
  'runtimeSetting',
  'managedSecret',
] as const;

export type ControlPlaneAuditResource =
  (typeof CONTROL_PLANE_AUDIT_RESOURCES)[number];

export type ControlPlaneAuditState =
  | { kind: 'featureFlagOverride'; enabled: boolean }
  | { kind: 'runtimeSettingValue'; value: unknown }
  | { kind: 'runtimeSettingValue'; redacted: true }
  | {
      kind: 'managedSecretSlot';
      configured: boolean;
      algorithm: string | null;
      keyVersion?: string | null;
    };

export type ControlPlaneAuditEntry = {
  id: string;
  occurredAt: Date;
  actorUserId: string | null;
  resource: string;
  action: string;
  resourceKey: string;
  organizationId: string | null;
  before: unknown;
  after: unknown;
};

export const AUDIT_PAGE_SIZE = 25;
export const MAX_AUDIT_PAGE_SIZE = 100;

type AuditWriter = Pick<PrismaService, 'controlPlaneAuditEvent'>;

@Injectable()
export class ControlPlaneAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    tx: AuditWriter,
    event: {
      action: ControlPlaneAuditAction;
      resourceKey: string;
      actorUserId: string | null;
      organizationId?: string;
      before: ControlPlaneAuditState | null;
      after: ControlPlaneAuditState | null;
    },
  ): Promise<void> {
    await tx.controlPlaneAuditEvent.create({
      data: {
        resource: resourceOf(event.action),
        action: event.action,
        resourceKey: event.resourceKey,
        actorUserId: event.actorUserId,
        organizationId: event.organizationId ?? null,
        before: asJson(event.before),
        after: asJson(event.after),
      },
    });
  }

  async list(input: {
    cursor?: string;
    limit?: number;
    resource?: string;
    resourceKey?: string;
    organizationId?: string;
  }): Promise<{ items: ControlPlaneAuditEntry[]; nextCursor: string | null }> {
    const take = auditPageSize(input.limit);
    const after =
      input.cursor === undefined ? null : decodeCursor(input.cursor);

    const rows = await this.prisma.controlPlaneAuditEvent.findMany({
      where: {
        ...(input.resource === undefined ? {} : { resource: input.resource }),
        ...(input.resourceKey === undefined
          ? {}
          : { resourceKey: input.resourceKey }),
        ...(input.organizationId === undefined
          ? {}
          : { organizationId: input.organizationId }),
        ...(after === null ? {} : beforePosition(after)),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      // One more than asked for, so "is there a next page" is answered without
      // a second query and without emitting a cursor for an empty one.
      take: take + 1,
      select: {
        id: true,
        occurredAt: true,
        actorUserId: true,
        resource: true,
        action: true,
        resourceKey: true,
        organizationId: true,
        before: true,
        after: true,
      },
    });

    const items = rows.slice(0, take);
    const last = items.at(-1);

    return {
      items,
      nextCursor:
        rows.length > take && last !== undefined
          ? encodeCursor({ occurredAt: last.occurredAt, id: last.id })
          : null,
    };
  }
}

function asJson(
  state: ControlPlaneAuditState | null,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return state === null ? Prisma.DbNull : (state as Prisma.InputJsonValue);
}

function resourceOf(
  action: ControlPlaneAuditAction,
): ControlPlaneAuditResource {
  return action.split('.')[0] as ControlPlaneAuditResource;
}

type AuditCursor = { occurredAt: Date; id: string };

function auditPageSize(requested: number | undefined): number {
  if (requested === undefined) return AUDIT_PAGE_SIZE;

  if (
    !Number.isInteger(requested) ||
    requested < 1 ||
    requested > MAX_AUDIT_PAGE_SIZE
  ) {
    throw new AppException('VALIDATION_ERROR', {
      context: { resource: 'controlPlaneAudit', reason: 'limit' },
      publicDetails: {
        reason: `A page size must be a whole number between 1 and ${MAX_AUDIT_PAGE_SIZE}.`,
      },
    });
  }

  return requested;
}

function beforePosition(after: AuditCursor) {
  return {
    OR: [
      { occurredAt: { lt: after.occurredAt } },
      { occurredAt: after.occurredAt, id: { lt: after.id } },
    ],
  };
}

function encodeCursor(cursor: AuditCursor): string {
  return Buffer.from(
    JSON.stringify({ at: cursor.occurredAt.toISOString(), id: cursor.id }),
    'utf8',
  ).toString('base64url');
}

function decodeCursor(value: string): AuditCursor {
  const invalid = () =>
    new AppException('VALIDATION_ERROR', {
      context: { resource: 'controlPlaneAudit', reason: 'cursor' },
      publicDetails: { reason: 'The page cursor is not readable.' },
    });

  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }

  if (typeof parsed !== 'object' || parsed === null) throw invalid();

  const { at, id } = parsed as Record<string, unknown>;

  if (typeof at !== 'string' || typeof id !== 'string') throw invalid();

  const occurredAt = new Date(at);

  if (Number.isNaN(occurredAt.getTime())) throw invalid();

  return { occurredAt, id };
}
