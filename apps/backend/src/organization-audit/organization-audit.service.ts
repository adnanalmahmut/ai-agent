import { Injectable } from '@nestjs/common';

import { PrismaService } from '../database';
import { AppException } from '../core/errors';
import { Prisma } from '../generated/prisma/client';
import type { OrganizationBusinessProfile } from '../organization-settings/organization-business-profile.types';

export const ORGANIZATION_AUDIT_ACTIONS = [
  'organizationBusinessProfile.replaced',
] as const;

export type OrganizationAuditAction =
  (typeof ORGANIZATION_AUDIT_ACTIONS)[number];

export const ORGANIZATION_AUDIT_SUBJECTS = [
  'organizationBusinessProfile',
] as const;

export type OrganizationAuditSubject =
  (typeof ORGANIZATION_AUDIT_SUBJECTS)[number];

/**
 * The only state the initial product-audit writer can persist.
 *
 * This is intentionally a closed projection rather than metadata or a request
 * body. Every field is application-owned, validated, and bounded by ORG-01;
 * there is nowhere for headers, credentials, cookies, or arbitrary caller data
 * to enter the row.
 */
export type OrganizationAuditState = {
  kind: 'organizationBusinessProfile';
  version: number;
  locale: string;
  timezone: string;
  currency: string;
  legalName: string | null;
  industry: string | null;
  websiteUrl: string | null;
  businessDescription: string | null;
};

export type OrganizationAuditEntry = {
  id: string;
  organizationId: string;
  occurredAt: Date;
  actorUserId: string | null;
  action: OrganizationAuditAction;
  subjectType: OrganizationAuditSubject;
  subjectId: string;
  before: OrganizationAuditState | null;
  after: OrganizationAuditState | null;
};

export const ORGANIZATION_AUDIT_PAGE_SIZE = 25;
export const MAX_ORGANIZATION_AUDIT_PAGE_SIZE = 100;

/** Just enough Prisma surface to append inside the caller's transaction. */
type OrganizationAuditWriter = Pick<PrismaService, 'organizationAuditEvent'>;

/**
 * Organization-owned product history.
 *
 * The write API is action-specific and takes a transaction client. There is no
 * generic `record(action, metadata)` escape hatch and no way to append outside
 * the mutation transaction. No method updates or deletes history.
 */
@Injectable()
export class OrganizationAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async recordBusinessProfileReplacement(
    tx: OrganizationAuditWriter,
    input: {
      organizationId: string;
      actorUserId: string;
      before: OrganizationBusinessProfile;
      after: OrganizationBusinessProfile;
    },
  ): Promise<void> {
    await tx.organizationAuditEvent.create({
      data: {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        action: 'organizationBusinessProfile.replaced',
        subjectType: 'organizationBusinessProfile',
        subjectId: input.organizationId,
        before: asJson(toBusinessProfileState(input.before)),
        after: asJson(toBusinessProfileState(input.after)),
      },
    });
  }

  /** One tenant-rooted, bounded, newest-first page of immutable history. */
  async list(input: {
    organizationId: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ items: OrganizationAuditEntry[]; nextCursor: string | null }> {
    const take = auditPageSize(input.limit);
    const after =
      input.cursor === undefined ? null : decodeCursor(input.cursor);

    const rows = await this.prisma.organizationAuditEvent.findMany({
      where: {
        organizationId: input.organizationId,
        ...(after === null ? {} : beforePosition(after)),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      select: {
        id: true,
        organizationId: true,
        occurredAt: true,
        actorUserId: true,
        action: true,
        subjectType: true,
        subjectId: true,
        before: true,
        after: true,
      },
    });

    const items = rows.slice(0, take).map(toEntry);
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

function toBusinessProfileState(
  profile: OrganizationBusinessProfile,
): OrganizationAuditState {
  return {
    kind: 'organizationBusinessProfile',
    version: profile.version,
    locale: profile.locale,
    timezone: profile.timezone,
    currency: profile.currency,
    legalName: profile.legalName,
    industry: profile.industry,
    websiteUrl: profile.websiteUrl,
    businessDescription: profile.businessDescription,
  };
}

function asJson(state: OrganizationAuditState): Prisma.InputJsonValue {
  return state;
}

function toEntry(row: {
  id: string;
  organizationId: string;
  occurredAt: Date;
  actorUserId: string | null;
  action: string;
  subjectType: string;
  subjectId: string;
  before: Prisma.JsonValue;
  after: Prisma.JsonValue;
}): OrganizationAuditEntry {
  return {
    ...row,
    action: row.action as OrganizationAuditAction,
    subjectType: row.subjectType as OrganizationAuditSubject,
    before: row.before as OrganizationAuditState | null,
    after: row.after as OrganizationAuditState | null,
  };
}

type AuditCursor = { occurredAt: Date; id: string };

function auditPageSize(requested: number | undefined): number {
  if (requested === undefined) return ORGANIZATION_AUDIT_PAGE_SIZE;

  if (
    !Number.isInteger(requested) ||
    requested < 1 ||
    requested > MAX_ORGANIZATION_AUDIT_PAGE_SIZE
  ) {
    throw new AppException('VALIDATION_ERROR', {
      context: { resource: 'organizationAudit', reason: 'limit' },
      publicDetails: {
        reason: `A page size must be a whole number between 1 and ${MAX_ORGANIZATION_AUDIT_PAGE_SIZE}.`,
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
      context: { resource: 'organizationAudit', reason: 'cursor' },
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

  if (
    typeof at !== 'string' ||
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > 120
  ) {
    throw invalid();
  }

  const occurredAt = new Date(at);
  if (Number.isNaN(occurredAt.getTime())) throw invalid();

  return { occurredAt, id };
}
