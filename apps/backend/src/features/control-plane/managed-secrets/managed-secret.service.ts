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

export type ManagedSecretDescription = {
  key: ManagedSecretKey;
  description: string;
  configured: boolean;
  label: string | undefined;
  algorithm: string | undefined;
  keyVersion: string | undefined;
  lastRotatedAt: Date | undefined;
  updatedAt: Date | undefined;
  usable: boolean;
};

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

  async set(input: {
    key: ManagedSecretKey;
    value: string;
    label?: string;
    actorUserId: string;
  }): Promise<ManagedSecretDescription> {
    const rejection = managedSecretDefinition(input.key).validate(input.value);

    if (rejection !== undefined) {
      throw new AppException('VALIDATION_ERROR', {
        context: { secretKey: input.key },
        publicDetails: { reason: rejection },
      });
    }

    const sealed = this.keyring.seal(input.key, input.value);

    await this.prisma.$transaction(async (tx) => {
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

      this.logger.warn(
        { secretKey: key, reason },
        'Stored managed secret could not be decrypted',
      );

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
