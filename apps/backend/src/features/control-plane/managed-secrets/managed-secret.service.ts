import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { AppException } from '../../../core/errors';
import { PrismaService } from '../../../infrastructure/database';
import {
  ControlPlaneAuditService,
  type ControlPlaneAuditState,
} from '../audit/control-plane-audit.service';
import {
  MANAGED_SECRET_KEYS,
  type ManagedSecretKey,
  managedSecretDefinition,
} from './managed-secret.registry';
import { SecretDecryptionError } from './secret-cipher';
import { ManagedSecretKeyring } from './managed-secret-keyring';

/**
 * Everything the control plane may know about a credential.
 *
 * Note what is absent and note that it is absent *by construction* — this type
 * has no field the plaintext could occupy, so a read surface cannot leak one by
 * forgetting to omit it. A masked preview is also absent: the first four
 * characters of an API key are a real substring of a real credential, and the
 * convenience of recognising it is not worth putting any of it on a screen.
 */
export type ManagedSecretDescription = {
  key: ManagedSecretKey;
  description: string;
  configured: boolean;
  label: string | undefined;
  algorithm: string | undefined;
  keyVersion: string | undefined;
  lastRotatedAt: Date | undefined;
  updatedAt: Date | undefined;
  /**
   * False when the row's exact version (or legacy fingerprint) cannot resolve
   * to an available key or its algorithm/fingerprint metadata is inconsistent.
   */
  usable: boolean;
};

/**
 * Provider credentials, encrypted in PostgreSQL.
 *
 * ## The rules this exists to enforce
 *
 * A stored secret is never returned by a read surface, never logged, and never
 * placed into `process.env`. The last one is the easy mistake and the worst:
 * anything in the environment is inherited by every child process and dumped by
 * every crash reporter, and it turns a scoped credential into an ambient one.
 * Instead `reveal` hands the plaintext directly to the one adapter that needs
 * it, at the moment it needs it.
 *
 * ## Why reads are not cached
 *
 * A cached credential outlives its rotation. An operator who rotates a leaked
 * key expects the next call to use the new one, and a TTL turns that into a
 * window where the compromised key is still in use. Provider calls take
 * hundreds of milliseconds; one indexed primary-key read and an AES decryption
 * are not what makes them slow.
 */
@Injectable()
export class ManagedSecretService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: ControlPlaneAuditService,
    private readonly keyring: ManagedSecretKeyring,
    private readonly logger: PinoLogger,
  ) {}

  async describeAll(): Promise<ManagedSecretDescription[]> {
    const rows = await this.prisma.managedSecret.findMany({
      // Explicit, and the ciphertext is not in it. A `findMany` with no select
      // would pull encrypted material into memory for a listing endpoint.
      select: {
        key: true,
        label: true,
        algorithm: true,
        keyFingerprint: true,
        keyVersion: true,
        lastRotatedAt: true,
        updatedAt: true,
      },
    });

    const stored = new Map(rows.map((row) => [row.key, row]));
    return MANAGED_SECRET_KEYS.map((key) => {
      const row = stored.get(key);

      return {
        key,
        description: managedSecretDefinition(key).description,
        configured: row !== undefined,
        label: row?.label ?? undefined,
        algorithm: row?.algorithm,
        keyVersion: row?.keyVersion ?? undefined,
        lastRotatedAt: row?.lastRotatedAt,
        updatedAt: row?.updatedAt,
        usable: row === undefined ? false : this.keyring.canDecrypt(row),
      };
    });
  }

  /**
   * Stores or replaces a credential.
   *
   * Rotation is the same operation as first configuration, deliberately: a
   * separate "rotate" path would be a second place to get the encryption right,
   * and the only differences are a timestamp and the label.
   *
   * The label is the exception because it is the operator's own note about
   * which account a credential belongs to, and it is not resubmitted when the
   * point of the call is to paste a new key. Treating an omitted label as
   * `null` would erase it on every rotation, silently, from the only surface
   * that shows it.
   */
  async set(input: {
    key: ManagedSecretKey;
    value: string;
    label?: string;
    actorUserId: string;
  }): Promise<ManagedSecretDescription> {
    const rejection = managedSecretDefinition(input.key).validate(input.value);

    if (rejection !== undefined) {
      /**
       * The reason is safe to return — it describes the shape a credential
       * should have, never the value submitted. `looksLikeCredential` is
       * written so that its messages cannot quote the input.
       */
      throw new AppException('VALIDATION_ERROR', {
        context: { secretKey: input.key },
        publicDetails: { reason: rejection },
      });
    }

    const sealed = this.keyring.seal(input.key, input.value);

    await this.prisma.$transaction(async (tx) => {
      /**
       * The audit needs only configuration state and cipher algorithm. A bare
       * read would pull credential material — or even an operator-supplied
       * label that might have been misused to hold it — into scope beside the
       * audit payload, so neither is selected here.
       */
      const before = await tx.managedSecret.findUnique({
        where: { key: input.key },
        select: { algorithm: true },
      });

      await tx.managedSecret.upsert({
        where: { key: input.key },
        create: {
          key: input.key,
          label: input.label ?? null,
          ...sealed,
          updatedByUserId: input.actorUserId,
        },
        update: {
          ...(input.label === undefined ? {} : { label: input.label }),
          ...sealed,
          lastRotatedAt: new Date(),
          updatedByUserId: input.actorUserId,
        },
      });

      /**
       * Configuring and rotating are distinct events even though they are one
       * operation. "This slot has never held a credential" and "the credential
       * in this slot was replaced" are different answers to the question an
       * incident actually asks, and collapsing them would lose the first.
       */
      await this.audit.record(tx, {
        action:
          before === null ? 'managedSecret.configure' : 'managedSecret.rotate',
        resourceKey: input.key,
        actorUserId: input.actorUserId,
        before: slotState(before),
        after: {
          kind: 'managedSecretSlot',
          configured: true,
          algorithm: sealed.algorithm,
        },
      });
    });

    return this.describe(input.key);
  }

  async remove(input: {
    key: ManagedSecretKey;
    actorUserId: string;
  }): Promise<ManagedSecretDescription> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.managedSecret.findUnique({
        where: { key: input.key },
        select: { algorithm: true },
      });

      await tx.managedSecret.deleteMany({ where: { key: input.key } });

      await this.audit.record(tx, {
        action: 'managedSecret.remove',
        resourceKey: input.key,
        actorUserId: input.actorUserId,
        before: slotState(before),
        after: {
          kind: 'managedSecretSlot',
          configured: false,
          algorithm: null,
        },
      });
    });

    return this.describe(input.key);
  }

  /**
   * Returns the plaintext, for one adapter, at the point of use.
   *
   * Not exposed through any controller and not reachable from a request
   * parameter: the key is a registry member chosen by the calling adapter. The
   * result must not be stored, logged, or copied into the environment.
   */
  async reveal(key: ManagedSecretKey): Promise<string> {
    const row = await this.prisma.managedSecret.findUnique({
      where: { key },
      select: {
        ciphertext: true,
        iv: true,
        authTag: true,
        algorithm: true,
        keyFingerprint: true,
        keyVersion: true,
      },
    });

    if (row === null) {
      throw new AppException('SECRET_NOT_CONFIGURED', {
        context: { secretKey: key },
      });
    }

    try {
      return this.keyring.open(key, row);
    } catch (error) {
      const reason =
        error instanceof SecretDecryptionError ? error.message : 'unknown';

      /**
       * Logged, not merely attached. The whole point of storing a key
       * fingerprint is that "encrypted under a different master key" and "this
       * row was altered" call for different responses, and a diagnosis that
       * only travels inside an exception the caller renders as "credential
       * unavailable" is a diagnosis nobody reads. The cipher's messages are
       * written so they cannot quote key or plaintext material, which is what
       * makes them safe to put in a log line beside a credential lookup.
       */
      this.logger.warn(
        { secretKey: key, reason },
        'Stored managed secret could not be decrypted',
      );

      /**
       * Re-raised as an application error so a provider adapter's failure path
       * cannot serialize a crypto error beside the credential it was fetching.
       */
      throw new AppException('SECRET_UNREADABLE', {
        context: { secretKey: key, reason },
      });
    }
  }

  private async describe(
    key: ManagedSecretKey,
  ): Promise<ManagedSecretDescription> {
    const all = await this.describeAll();

    return all.find((entry) => entry.key === key)!;
  }
}

/**
 * A credential slot as the audit log records it.
 *
 * Two non-secret facts and no third. `ControlPlaneAuditState` has no member
 * a plaintext or a ciphertext could occupy, so this cannot be widened at a call
 * site — the type is the containment, not this function's discipline.
 */
function slotState(
  row: { algorithm: string } | null,
): ControlPlaneAuditState | null {
  return row === null
    ? null
    : {
        kind: 'managedSecretSlot',
        configured: true,
        algorithm: row.algorithm,
      };
}
