import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../infrastructure/database';
import { ControlPlaneAuditService } from '../audit/control-plane-audit.service';
import {
  ManagedSecretKeyring,
  type StoredManagedSecretCipher,
} from './managed-secret-keyring';
import { isManagedSecretKey } from './managed-secret.registry';
import { SecretDecryptionError } from './secret-cipher';

export const DEFAULT_ROTATION_BATCH_SIZE = 50;
export const MAX_ROTATION_BATCH_SIZE = 500;

export type RotationDisposition =
  | 'rotated'
  | 'alreadyActive'
  | 'wouldRotate'
  | 'unreadable'
  | 'concurrentlyModified'
  | 'unknownSlot';

export type RotationOutcome = {
  key: string;
  disposition: RotationDisposition;
  fromKeyVersion: string | null;
};

export type RotationReport = {
  examined: number;
  rotated: number;
  alreadyActive: number;
  wouldRotate: number;
  unreadable: number;
  concurrentlyModified: number;
  unknownSlot: number;
  outcomes: RotationOutcome[];
};

export type RotationOptions = {
  batchSize?: number;
  dryRun?: boolean;
};

const CIPHER_SELECT = {
  key: true,
  ciphertext: true,
  iv: true,
  authTag: true,
  algorithm: true,
  keyFingerprint: true,
  keyVersion: true,
  updatedAt: true,
} as const;

@Injectable()
export class ManagedSecretRotationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly keyring: ManagedSecretKeyring,
    private readonly audit: ControlPlaneAuditService,
  ) {}

  async rotateAll(options: RotationOptions = {}): Promise<RotationReport> {
    const batchSize = normalizeBatchSize(options.batchSize);
    const dryRun = options.dryRun === true;
    const report: RotationReport = {
      examined: 0,
      rotated: 0,
      alreadyActive: 0,
      wouldRotate: 0,
      unreadable: 0,
      concurrentlyModified: 0,
      unknownSlot: 0,
      outcomes: [],
    };

    // The keyset cursor is the last key of the previous page. `undefined` on
    // the first pass rather than an empty string, because an empty string is a
    // legitimate value for a text column and `gt: ''` would silently exclude it.
    let after: string | undefined;

    for (;;) {
      const page = await this.prisma.managedSecret.findMany({
        where: after === undefined ? {} : { key: { gt: after } },
        orderBy: { key: 'asc' },
        take: batchSize,
        select: CIPHER_SELECT,
      });

      if (page.length === 0) break;

      after = page[page.length - 1].key;

      for (const row of page) {
        const outcome = await this.rotateRow(row, dryRun);

        report.examined += 1;
        report[outcome.disposition] += 1;
        report.outcomes.push(outcome);
      }
    }

    return report;
  }

  private async rotateRow(
    row: StoredManagedSecretCipher & { key: string; updatedAt: Date },
    dryRun: boolean,
  ): Promise<RotationOutcome> {
    const from = row.keyVersion;
    const at = (disposition: RotationDisposition): RotationOutcome => ({
      key: row.key,
      disposition,
      fromKeyVersion: from,
    });

    if (!isManagedSecretKey(row.key)) return at('unknownSlot');

    let plaintext: string;
    try {
      plaintext = this.keyring.open(row.key, row);
    } catch (error) {
      // Deliberately swallowed rather than rethrown or logged with its message.
      // The keyring's own errors are already plaintext-free, but the caller
      // needs a disposition rather than a reason, and a reason string is one
      // more surface beside credential material for no operational gain.
      if (error instanceof SecretDecryptionError) return at('unreadable');
      throw error;
    }

    if (row.keyVersion === this.keyring.activeKeyVersion) {
      return at('alreadyActive');
    }

    if (dryRun) return at('wouldRotate');

    const sealed = this.keyring.seal(row.key, plaintext);

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.managedSecret.updateMany({
        where: {
          key: row.key,
          updatedAt: row.updatedAt,
          ciphertext: row.ciphertext,
        },
        data: {
          ciphertext: sealed.ciphertext,
          iv: sealed.iv,
          authTag: sealed.authTag,
          algorithm: sealed.algorithm,
          keyFingerprint: sealed.keyFingerprint,
          keyVersion: sealed.keyVersion,
        },
      });

      if (count !== 1) return at('concurrentlyModified');

      await this.audit.record(tx, {
        action: 'managedSecret.reencrypt',
        resourceKey: row.key,
        // No user performed this. The command runs from a terminal against the
        // deployment's own configuration, and inventing an actor would be a
        // worse record than an honest absent one.
        actorUserId: null,
        before: {
          kind: 'managedSecretSlot',
          configured: true,
          algorithm: row.algorithm,
          keyVersion: row.keyVersion,
        },
        after: {
          kind: 'managedSecretSlot',
          configured: true,
          algorithm: sealed.algorithm,
          keyVersion: sealed.keyVersion,
        },
      });

      return at('rotated');
    });
  }
}

function normalizeBatchSize(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_ROTATION_BATCH_SIZE;

  if (
    !Number.isInteger(requested) ||
    requested < 1 ||
    requested > MAX_ROTATION_BATCH_SIZE
  ) {
    throw new RangeError(
      `batch size must be an integer between 1 and ${MAX_ROTATION_BATCH_SIZE}`,
    );
  }

  return requested;
}
