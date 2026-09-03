import { Injectable } from '@nestjs/common';

import { AppException } from '../../../core/errors';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../infrastructure/database';

/**
 * Every control-plane mutation that is recorded, named once.
 *
 * A union of literals rather than `string`, so a new mutation cannot be added
 * without deciding what it is called and what its safe projection is. The names
 * are `resource.verb` and they are what the Platform translates, so renaming
 * one is a visible change rather than a silent one.
 *
 * Clearing and setting are separate actions because they are separate
 * decisions: a cleared flag follows the code default when it changes, a flag
 * pinned to the default's current value does not. An audit log that recorded
 * both as "set" would lose exactly the distinction an operator went to the
 * trouble of expressing.
 */
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
  /**
   * Re-encryption of an unchanged credential under a different master key
   * version. Separate from `managedSecret.rotate` because the two answer
   * different questions: rotate means an operator supplied a new credential
   * value, reencrypt means the same value is now sealed under a different key.
   * Collapsing them would lose exactly the distinction an auditor needs while
   * reading a key rollout.
   */
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

/**
 * The safe state of a control-plane resource, in the only shapes this log
 * accepts.
 *
 * A closed union, and that is the containment mechanism rather than a rule
 * somebody has to remember. There is no member a credential could occupy: a
 * managed secret's state is a few non-secret facts, and a runtime setting's
 * value is either public or replaced by `{ redacted: true }`. A future caller
 * trying to log a plaintext has nowhere to put it, and widening this type is
 * the one change that would make such a call compile.
 */
export type ControlPlaneAuditState =
  | { kind: 'featureFlagOverride'; enabled: boolean }
  | { kind: 'runtimeSettingValue'; value: unknown }
  | { kind: 'runtimeSettingValue'; redacted: true }
  | {
      kind: 'managedSecretSlot';
      configured: boolean;
      algorithm: string | null;
      /**
       * Which configured key sealed the row — a bounded, non-secret identifier.
       *
       * The managed-secrets read model carries it too, though no listing surface
       * renders it; the one place it reaches a screen is the audit table's change
       * column, and it passes a display gate there rather than being printed as
       * received. Do not read this member as licence to render the field
       * elsewhere. Optional
       * because the callers that record configure/rotate/remove describe a
       * slot's existence rather than its encryption, and absent is honest there;
       * re-encryption is the one action whose whole content is this field
       * changing. `null` is a pre-version row.
       */
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

/** The default page, and the ceiling a caller cannot raise. */
export const AUDIT_PAGE_SIZE = 25;
export const MAX_AUDIT_PAGE_SIZE = 100;

/** Just enough of a Prisma client to write one row inside a transaction. */
type AuditWriter = Pick<PrismaService, 'controlPlaneAuditEvent'>;

/**
 * The control plane's history.
 *
 * ## Why the write takes a transaction client
 *
 * Every `record` call is made inside the same transaction as the mutation it
 * describes, and that is the whole point: an acknowledged write must not be
 * able to exist without its audit row. Writing the log afterwards would make
 * the two independent, and the case where they diverge is the case that
 * matters — a process killed between the two leaves a changed flag nobody
 * changed. There is deliberately no method here that writes outside a
 * transaction.
 *
 * ## Why it is append-only
 *
 * Nothing in this class updates or deletes. History survives the resource it
 * describes: clearing a feature-flag override removes the row that carried
 * `updatedByUserId`, which is precisely when the record of who set it becomes
 * the only evidence there is.
 *
 * ## What is never written
 *
 * Secret plaintext, ciphertext, IVs, auth tags, and non-public setting values.
 * `ControlPlaneAuditState` has no field for any of them, so this is a property
 * of the type rather than of the caller's care.
 */
@Injectable()
export class ControlPlaneAuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Appends one event, in the caller's transaction.
   *
   * `before` and `after` are both nullable and both meaningful when null:
   * absent `before` means the resource had no stored state, absent `after`
   * means it no longer has one. A pair of nulls would be a no-op nobody should
   * be recording, and the callers that could produce one — clearing an override
   * or resetting a setting that was never stored — return before reaching here
   * rather than appending an event for a change that did not happen. It is not
   * refused here as well because a caller that has decided something happened
   * is better trusted than second-guessed: this class appends, and the decision
   * about whether there was a change belongs to the service that made it.
   */
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
        /**
         * `Prisma.DbNull`, not `null`.
         *
         * A nullable `Json` column has two nulls — SQL NULL and the JSON value
         * `null` — so Prisma refuses the ambiguous bare `null` and makes the
         * caller say which. SQL NULL is the one meant here: the resource had no
         * state, rather than having a state that is literally `null`.
         */
        before: asJson(event.before),
        after: asJson(event.after),
      },
    });
  }

  /**
   * One bounded page of history, newest first.
   *
   * Keyset paged on `(occurredAt, id)` descending. Offset paging is wrong here
   * for the reason it is wrong everywhere the collection grows at the end being
   * read from: a mutation committed between two page reads shifts every row,
   * and the reader silently skips one.
   */
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

/**
 * A safe state as Prisma's Json input, or SQL NULL.
 *
 * `Prisma.DbNull`, not `null`: a nullable `Json` column has two nulls — SQL
 * NULL and the JSON value `null` — so Prisma refuses the ambiguous bare `null`
 * and makes the caller say which. SQL NULL is the one meant here, because the
 * fact being recorded is that the resource had no state at all.
 *
 * The cast is the one place this module asserts rather than proves. Every
 * member of `ControlPlaneAuditState` is a plain object of JSON scalars except
 * the runtime setting's `value`, which is `unknown` because the registry — not
 * this file — owns each setting's type. It is JSON in practice by construction:
 * it has just been round-tripped through a Zod schema from a `Json` column, or
 * is about to be written to one. Narrowing the field to a JSON type here would
 * make the audit log a second opinion about what a setting may hold.
 */
function asJson(
  state: ControlPlaneAuditState | null,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return state === null ? Prisma.DbNull : (state as Prisma.InputJsonValue);
}

/** The resource half of an action name, derived rather than passed twice. */
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

/** Everything strictly older than the cursor, in `(occurredAt, id)` order. */
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

/**
 * Parses a cursor, refusing anything that is not one.
 *
 * Refused rather than ignored: a dropped cursor restarts the listing at the
 * newest event, which a client paging backwards through history reads as an
 * endless log.
 */
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
