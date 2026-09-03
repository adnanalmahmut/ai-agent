import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../infrastructure/database';
import { ControlPlaneAuditService } from '../audit/control-plane-audit.service';
import {
  ManagedSecretKeyring,
  type StoredManagedSecretCipher,
} from './managed-secret-keyring';
import { isManagedSecretKey } from './managed-secret.registry';
import { SecretDecryptionError } from './secret-cipher';

/** Rows read per page. Bounded so one pass cannot load the table at once. */
export const DEFAULT_ROTATION_BATCH_SIZE = 50;
export const MAX_ROTATION_BATCH_SIZE = 500;

/**
 * What happened to one row, in the only shapes this sweep produces.
 *
 * `unknownSlot` exists because the table's primary key is a registry slot name
 * and the registry is code-owned: a row whose key is not in the current
 * registry was written by a different build. Its authenticated data is derived
 * from that slot name, so this build can neither re-seal it nor even verify it
 * — it is the one disposition not backed by a decryption, and it is reported
 * rather than guessed at for exactly that reason.
 */
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
  /** Non-secret version identifier the row carried when it was read. */
  fromKeyVersion: string | null;
};

/**
 * The result of one sweep.
 *
 * Counts and code-owned slot names only. There is deliberately no member a
 * plaintext, a key, or a ciphertext could occupy.
 */
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

/** The columns a rotation needs, and nothing else. */
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

/**
 * Re-encrypts stored managed secrets under the configured active key version.
 *
 * This is the migration SEC-01A deferred. That change made a row's key version
 * explicit and let an older key stay configured for decryption; it left every
 * existing row where it was. Until those rows are re-encrypted, the old key
 * cannot be retired, so something has to walk the table — and the walk has to
 * be safe to interrupt, safe to repeat, and incapable of overwriting a
 * credential an operator changed while it was running.
 *
 * Three properties carry that weight, and each is a deliberate choice rather
 * than an incidental one:
 *
 * Pagination is on `key`, the immutable primary key, not on "rows that still
 * need rotating". Paging on the rotation predicate would be smaller, but loop
 * progress would then depend on a condition concurrent writes mutate: a row
 * changing under the reader could move across the predicate between pages and
 * never be visited. An immutable unique ordering cannot lose or reorder a row
 * regardless of what else is happening to it.
 *
 * The write is a compare-and-swap guarded on the `updatedAt` that was read. Any
 * other writer — an operator entering a new credential through the control
 * plane — advances that column, so the guard matches nothing and the newer
 * value survives. A re-encryption of a value that has since been replaced is
 * exactly the write that must not land.
 *
 * Every row is authenticated before anything is concluded about it, and that
 * includes the rows this sweep does not write. A row is re-sealed only after its
 * plaintext was recovered; a row that cannot be decrypted is counted and left
 * byte for byte as it was; and a row already on the active version is called
 * current only when it proves it can still be opened. The last of those is what
 * makes the report usable as the gate before a key is deleted — metadata alone
 * cannot see an altered ciphertext, and a table reported as fully rotated on
 * that basis is exactly how the only key that could read a row gets retired.
 * The sweep continues past a failure, because one unreadable credential is not
 * a reason to abandon the rest, and the caller's non-zero exit is what stops a
 * partial result from reading as a complete one.
 */
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

    /**
     * The registry first, because AAD is derived from the slot name.
     *
     * A row whose key is not in this build's registry cannot be authenticated
     * at all, let alone re-sealed: the binding a versioned row was sealed with
     * names a slot this build does not define, so there is nothing to compare
     * against. Every other disposition below is a statement backed by a real
     * decryption, and this is the one row about which no such statement can be
     * made — so it is reported rather than guessed at.
     */
    if (!isManagedSecretKey(row.key)) return at('unknownSlot');

    /**
     * One authenticated decryption, and every disposition after it is backed by
     * it — including `alreadyActive`.
     *
     * The version column is a plain text field, not a proof, and the fingerprint
     * beside it only proves which key material is configured under that version.
     * Neither can see a ciphertext that has been altered. Deciding `alreadyActive`
     * from metadata would report a corrupted row as fully rotated, and the
     * runbook's retirement gate reads exactly that to authorize deleting the only
     * key that could still have read it. So a row claims to be current only when
     * it can prove it, on a live run and a dry run alike: the dry run *is* that
     * gate, and a cheaper check there would be the one place the guarantee is
     * missing.
     *
     * The cost is one AES-GCM open per row per sweep, against a code-owned
     * registry of a handful of slots. The plaintext is a local binding, is never
     * assigned to a field, logged, or returned, and is unreachable once this
     * function returns — the same lifetime the write path below already accepts,
     * for the rows it does not write.
     */
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
        /**
         * The compare-and-swap. `updatedAt` is what any other writer advances,
         * so requiring the value this row was read at is what makes a
         * concurrent credential change win instead of being overwritten by a
         * re-encryption of the value it replaced.
         *
         * The ciphertext is in the predicate as well, and it is what makes the
         * guard exact rather than merely very likely. Prisma computes
         * `@updatedAt` in JavaScript against a `timestamp(3)` column, so the
         * timestamp alone is a millisecond discriminator: two writes to one row
         * inside the same millisecond would compare equal and the guard would
         * match a row it should refuse. Comparing the bytes actually being
         * replaced removes that dependency on clock granularity entirely — and
         * they are the thing this update overwrites, so they are the honest
         * subject of the comparison.
         *
         * `lastRotatedAt` and `updatedByUserId` are not in `data`: they record
         * that an operator supplied a new credential, and re-encrypting the
         * same secret under a different key is not that.
         */
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
