import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ConfigType } from '@nestjs/config';

import type { encryptionConfig } from '../../../../../src/infrastructure/config';
import type { PrismaService } from '../../../../../src/infrastructure/database';
import { ControlPlaneAuditService } from '../../../../../src/features/control-plane/audit/control-plane-audit.service';
import { ManagedSecretKeyring } from '../../../../../src/features/control-plane/managed-secrets/managed-secret-keyring';
import {
  DEFAULT_ROTATION_BATCH_SIZE,
  MAX_ROTATION_BATCH_SIZE,
  ManagedSecretRotationService,
} from '../../../../../src/features/control-plane/managed-secrets/managed-secret-rotation.service';
import {
  fingerprintKey,
  sealSecret,
  type StoredBytes,
} from '../../../../../src/features/control-plane/managed-secrets/secret-cipher';

/**
 * The re-encryption sweep, tested for what it must never do.
 *
 * Three claims carry the weight and each is driven directly: a row is written
 * only after its plaintext was recovered and re-sealed, a row someone else
 * changed is never overwritten, and nothing that happens here puts a credential
 * anywhere a person or a log could read it. Every failure path is driven with
 * the same canary and the result is searched for it.
 */

const ACTIVE_KEY = Buffer.alloc(32, 0x11);
const OLD_KEY = Buffer.alloc(32, 0x22);
const RETIRED_KEY = Buffer.alloc(32, 0x33);
const SLOT = 'openai.api_key';
const CANARY = 'sk-CANARY-rotation-do-not-log-000000';

const encryption: ConfigType<typeof encryptionConfig> = {
  masterKey: ACTIVE_KEY,
  activeKeyVersion: 'v2',
  decryptOnlyKeys: [{ version: 'v1', key: OLD_KEY }],
};

const aad = (version: string) => `managed-secret:v1:${SLOT}:${version}`;

const READ_AT = new Date('2026-03-01T00:00:00.000Z');

type Row = {
  key: string;
  ciphertext: StoredBytes;
  iv: StoredBytes;
  authTag: StoredBytes;
  algorithm: string;
  keyFingerprint: string;
  keyVersion: string | null;
  updatedAt: Date;
};

/** A row as the previous key version wrote it: versioned, AAD-bound. */
const oldVersionRow = (key = SLOT): Row => ({
  key,
  ...sealSecret(CANARY, OLD_KEY, aad('v1')),
  keyVersion: 'v1',
  updatedAt: READ_AT,
});

/** A row from before key versions existed: no version, no AAD. */
const legacyRow = (key = SLOT, material = OLD_KEY): Row => ({
  key,
  ...sealSecret(CANARY, material),
  keyVersion: null,
  updatedAt: READ_AT,
});

const activeRow = (key = SLOT): Row => ({
  key,
  ...sealSecret(CANARY, ACTIVE_KEY, aad('v2')),
  keyVersion: 'v2',
  updatedAt: READ_AT,
});

const flipByte = (bytes: StoredBytes): StoredBytes => {
  const copy = new Uint8Array(bytes);
  copy[0] ^= 0xff;

  return copy;
};

describe('ManagedSecretRotationService', () => {
  const findMany = jest.fn<(args: never) => Promise<Row[]>>();
  const updateMany = jest.fn<(args: never) => Promise<{ count: number }>>();
  const auditCreate = jest.fn<(args: never) => Promise<unknown>>();

  const prisma = {
    managedSecret: { findMany, updateMany },
    controlPlaneAuditEvent: { create: auditCreate },
    /** One client for both writes; that they commit together is an e2e claim. */
    $transaction: (work: (tx: unknown) => Promise<unknown>) => work(prisma),
  } as unknown as PrismaService;

  const keyring = new ManagedSecretKeyring(encryption);
  let service: ManagedSecretRotationService;

  /** Serves `rows` as one page, then an empty page to end the sweep. */
  const servePages = (...pages: Row[][]) => {
    findMany.mockReset();
    for (const page of pages) findMany.mockResolvedValueOnce(page);
    findMany.mockResolvedValue([]);
  };

  beforeEach(() => {
    updateMany.mockReset().mockResolvedValue({ count: 1 });
    auditCreate.mockReset().mockResolvedValue(undefined);
    service = new ManagedSecretRotationService(
      prisma,
      keyring,
      new ControlPlaneAuditService(prisma),
    );
  });

  describe('what it rotates', () => {
    it('re-seals an old-version row under the active version', async () => {
      servePages([oldVersionRow()]);

      const report = await service.rotateAll();

      expect(report).toMatchObject({ examined: 1, rotated: 1 });

      const written = writtenData();
      expect(written.keyVersion).toBe('v2');
      expect(written.keyFingerprint).toBe(fingerprintKey(ACTIVE_KEY));
      // The value survived the round trip, and it is the active key that reads
      // it back — the whole point of the rotation.
      expect(keyring.open(SLOT, { ...written, keyVersion: 'v2' })).toBe(CANARY);
    });

    /**
     * The migration SEC-01A deferred: a row written before versions existed
     * carries no version and no AAD, and comes out the far side with both.
     */
    it('migrates a pre-version row onto the active version', async () => {
      servePages([legacyRow()]);

      const report = await service.rotateAll();

      expect(report).toMatchObject({ examined: 1, rotated: 1 });
      expect(writtenData().keyVersion).toBe('v2');
    });

    it('leaves a row already on the active version untouched', async () => {
      servePages([activeRow()]);

      const report = await service.rotateAll();

      expect(report).toMatchObject({
        examined: 1,
        alreadyActive: 1,
        rotated: 0,
      });
      expect(updateMany).not.toHaveBeenCalled();
    });

    /**
     * The retirement gate's worst case, and the reason `alreadyActive` costs a
     * decryption.
     *
     * A tampered ciphertext leaves the version column and the key fingerprint
     * exactly as they were — both describe the *key*, not the bytes — so any
     * metadata-only check calls this row current. It would then be counted
     * toward "nothing left to rotate", and the runbook's step D would authorize
     * deleting the old key while a row sits there that nothing can read.
     *
     * Weakening the service to decide `alreadyActive` from `canDecrypt` (or from
     * the version string alone) makes this test fail, which is the whole point
     * of it.
     */
    it.each([
      [
        'a tampered ciphertext',
        (): Row => {
          const row = activeRow();
          return { ...row, ciphertext: flipByte(row.ciphertext) };
        },
      ],
      [
        'a tampered authentication tag',
        (): Row => {
          const row = activeRow();
          return { ...row, authTag: flipByte(row.authTag) };
        },
      ],
      [
        'a tampered iv',
        (): Row => {
          const row = activeRow();
          return { ...row, iv: flipByte(row.iv) };
        },
      ],
    ])(
      'refuses to call an active-version row current when it has %s',
      async (_label, build) => {
        servePages([build()]);

        const report = await service.rotateAll();

        expect(report).toMatchObject({
          examined: 1,
          unreadable: 1,
          alreadyActive: 0,
          rotated: 0,
        });
        expect(updateMany).not.toHaveBeenCalled();
      },
    );

    /** And the same on the dry run, which is the gate an operator actually reads. */
    it('refuses to call a tampered active-version row current on a dry run', async () => {
      const row = activeRow();
      servePages([{ ...row, ciphertext: flipByte(row.ciphertext) }]);

      const report = await service.rotateAll({ dryRun: true });

      expect(report).toMatchObject({
        examined: 1,
        unreadable: 1,
        alreadyActive: 0,
        wouldRotate: 0,
      });
    });

    it('reports nothing for an empty table', async () => {
      servePages([]);

      const report = await service.rotateAll();

      expect(report).toMatchObject({ examined: 0, rotated: 0 });
      expect(updateMany).not.toHaveBeenCalled();
    });

    /**
     * The registry defines exactly one slot today, so a "mixed table" is
     * expressed across pages of that slot rather than by inventing slot names
     * the build would rightly refuse.
     */
    it('rotates only what needs it in a mixed table', async () => {
      servePages([activeRow()], [oldVersionRow()], [legacyRow()]);

      const report = await service.rotateAll({ batchSize: 1 });

      expect(report).toMatchObject({
        examined: 3,
        rotated: 2,
        alreadyActive: 1,
      });
      expect(updateMany).toHaveBeenCalledTimes(2);
    });

    /** Re-running a finished rotation is every row taking the no-op branch. */
    it('is a no-op when run again over a rotated table', async () => {
      servePages([activeRow()], [activeRow()]);

      const report = await service.rotateAll({ batchSize: 1 });

      expect(report).toMatchObject({
        examined: 2,
        rotated: 0,
        alreadyActive: 2,
      });
      expect(updateMany).not.toHaveBeenCalled();
    });
  });

  describe('concurrency', () => {
    /**
     * The claim this whole design exists for. An operator entering a new
     * credential mid-sweep advances `updatedAt`, the guarded update matches
     * nothing, and their value is what remains — rather than being replaced by
     * a re-encryption of the value they just retired.
     */
    it('never overwrites a row that changed while it was being rotated', async () => {
      servePages([oldVersionRow()]);
      updateMany.mockResolvedValue({ count: 0 });

      const report = await service.rotateAll();

      expect(report).toMatchObject({
        examined: 1,
        rotated: 0,
        concurrentlyModified: 1,
      });
      // The losing CAS must not leave an audit entry claiming it rotated.
      expect(auditCreate).not.toHaveBeenCalled();
    });

    /**
     * The predicate, asserted exactly.
     *
     * `toEqual` rather than `toMatchObject`, because the claim is about what the
     * guard *is*: a field quietly dropped from it is the regression, and a
     * subset match would not notice. `updatedAt` is what another writer
     * advances; the ciphertext is what makes the guard exact rather than merely
     * very likely, since Prisma's `@updatedAt` resolves to millisecond
     * granularity and two writes inside one millisecond would compare equal.
     */
    it('guards the update on the exact row it read', async () => {
      const read = oldVersionRow();
      servePages([read]);

      await service.rotateAll();

      expect(updateManyArgs().where).toEqual({
        key: SLOT,
        updatedAt: READ_AT,
        ciphertext: read.ciphertext,
      });
    });

    /**
     * `lastRotatedAt` and `updatedByUserId` describe an operator supplying a
     * new credential. Re-encrypting an unchanged one is not that, and writing
     * them would make the control plane report a credential rotation that never
     * happened.
     */
    it('does not disturb credential-rotation bookkeeping', async () => {
      servePages([oldVersionRow()]);

      await service.rotateAll();

      const written = updateManyArgs().data;
      expect(written).not.toHaveProperty('lastRotatedAt');
      expect(written).not.toHaveProperty('updatedByUserId');
    });
  });

  describe('failing closed', () => {
    it.each([
      ['an unknown recorded version', { ...oldVersionRow(), keyVersion: 'v9' }],
      ['a key that is no longer configured', legacyRow(SLOT, RETIRED_KEY)],
      [
        'a tampered ciphertext',
        (() => {
          const row = oldVersionRow();
          return { ...row, ciphertext: flipByte(row.ciphertext) };
        })(),
      ],
      [
        'a tampered authentication tag',
        (() => {
          const row = oldVersionRow();
          return { ...row, authTag: flipByte(row.authTag) };
        })(),
      ],
    ])('leaves a row with %s exactly as it was', async (_label, row) => {
      servePages([row]);

      const report = await service.rotateAll();

      expect(report).toMatchObject({ examined: 1, unreadable: 1, rotated: 0 });
      expect(updateMany).not.toHaveBeenCalled();
      expect(auditCreate).not.toHaveBeenCalled();
    });

    /** One bad credential is not a reason to abandon the rest of the table. */
    it('continues past an unreadable row', async () => {
      servePages([{ ...oldVersionRow(), keyVersion: 'v9' }], [oldVersionRow()]);

      const report = await service.rotateAll({ batchSize: 1 });

      expect(report).toMatchObject({ examined: 2, unreadable: 1, rotated: 1 });
    });

    /**
     * The primary key is a code-owned registry slot, and AAD is derived from
     * it. A row naming a slot this build does not define cannot be re-sealed
     * without inventing that name, so it is reported rather than guessed at.
     */
    it('refuses a row whose slot this build does not define', async () => {
      servePages([{ ...oldVersionRow('retired.api_key') }]);

      const report = await service.rotateAll();

      expect(report).toMatchObject({ examined: 1, unknownSlot: 1, rotated: 0 });
      expect(updateMany).not.toHaveBeenCalled();
    });

    /**
     * Even when it looks current.
     *
     * The slot check comes before the version check deliberately. The AAD a
     * versioned row was sealed with contains the slot name, so this build cannot
     * authenticate such a row at all — and `alreadyActive` is a claim that the
     * row was opened. Reporting it as current would be asserting something
     * nothing here verified; `unknownSlot` says exactly what is true, and the
     * command's non-zero exit makes an operator reconcile it rather than read
     * past it. The runbook documents the remedy.
     */
    it('refuses an unknown slot even on the active key version', async () => {
      servePages([activeRow('retired.api_key')]);

      const report = await service.rotateAll();

      expect(report).toMatchObject({
        examined: 1,
        unknownSlot: 1,
        alreadyActive: 0,
      });
      expect(updateMany).not.toHaveBeenCalled();
    });
  });

  describe('pagination', () => {
    it('pages on the immutable primary key, ascending', async () => {
      servePages([oldVersionRow('a'), oldVersionRow('b')]);

      await service.rotateAll({ batchSize: 2 });

      const [first, second] = findMany.mock.calls.map(
        ([args]) => args as unknown as Record<string, unknown>,
      );
      expect(first).toMatchObject({
        where: {},
        orderBy: { key: 'asc' },
        take: 2,
      });
      // The cursor is the last key of the previous page, so no row is revisited
      // and none is stepped over.
      expect(second).toMatchObject({ where: { key: { gt: 'b' } } });
    });

    it('visits every row across several pages exactly once', async () => {
      servePages(
        [oldVersionRow('a'), oldVersionRow('b')],
        [oldVersionRow('c')],
      );

      const report = await service.rotateAll({ batchSize: 2 });

      // Every row is visited once, in key order, across the page boundary.
      // The dispositions are beside the point here — these keys are not
      // registry slots — so only the traversal is asserted.
      expect(report.examined).toBe(3);
      expect(report.outcomes.map((outcome) => outcome.key)).toEqual([
        'a',
        'b',
        'c',
      ]);
    });

    it('asks for the default page size when none is given', async () => {
      servePages([]);

      await service.rotateAll();

      expect(
        (findMany.mock.calls[0][0] as unknown as { take: number }).take,
      ).toBe(DEFAULT_ROTATION_BATCH_SIZE);
    });

    it.each([0, -1, 1.5, MAX_ROTATION_BATCH_SIZE + 1])(
      'refuses the unusable batch size %s',
      async (size) => {
        servePages([]);

        await expect(service.rotateAll({ batchSize: size })).rejects.toThrow(
          /batch size/,
        );
      },
    );
  });

  describe('dry run', () => {
    it('reports what would change and writes nothing', async () => {
      servePages([oldVersionRow()], [activeRow()]);

      const report = await service.rotateAll({ dryRun: true, batchSize: 1 });

      expect(report).toMatchObject({
        examined: 2,
        wouldRotate: 1,
        alreadyActive: 1,
        rotated: 0,
      });
      expect(updateMany).not.toHaveBeenCalled();
      expect(auditCreate).not.toHaveBeenCalled();
    });

    /**
     * A dry run whose job is to answer "is anything left before I retire the
     * old key" must not answer "one row would rotate" about a row that in fact
     * cannot be decrypted at all.
     */
    it('reports an unreadable row as unreadable, not as rotatable', async () => {
      servePages([legacyRow(SLOT, RETIRED_KEY)]);

      const report = await service.rotateAll({ dryRun: true });

      expect(report).toMatchObject({ unreadable: 1, wouldRotate: 0 });
    });

    /**
     * The case that separates a real decryption from a metadata check.
     *
     * A missing key is visible in the fingerprint, so the test above passes
     * either way. A *tampered* ciphertext is not: the version, the algorithm and
     * the fingerprint all still agree, and only an authenticated open can tell
     * that the bytes will not decrypt. Reporting this row as `wouldRotate` would
     * promise an operator that a live run will succeed on a row that cannot be
     * read at all — and the dry run is precisely the promise they act on.
     */
    it('authenticates the ciphertext rather than trusting its metadata', async () => {
      const row = oldVersionRow();
      servePages([{ ...row, ciphertext: flipByte(row.ciphertext) }]);

      const report = await service.rotateAll({ dryRun: true });

      expect(report).toMatchObject({
        examined: 1,
        unreadable: 1,
        wouldRotate: 0,
      });
      expect(updateMany).not.toHaveBeenCalled();
    });
  });

  describe('the canary appears nowhere', () => {
    it.each([
      ['a rotated row', () => servePages([oldVersionRow()]), {}],
      ['a legacy row', () => servePages([legacyRow()]), {}],
      [
        'an unreadable row',
        () => servePages([{ ...oldVersionRow(), keyVersion: 'v9' }]),
        {},
      ],
      // The options matter here. Without them this case arranged the same rows
      // as the first and called `rotateAll()` the same way, so it re-ran the
      // rotated-row case under a different label and the dry-run path -- which
      // decrypts, and so holds the plaintext, without ever writing -- was never
      // examined at all.
      ['a dry run', () => servePages([oldVersionRow()]), { dryRun: true }],
    ])(
      'is absent from the report and the audit payload: %s',
      async (_label, arrange, options) => {
        arrange();

        const report = await service.rotateAll(options);

        const surface = JSON.stringify({
          report,
          audit: auditCreate.mock.calls,
          // What was written is ciphertext; asserting the plaintext is not in it
          // is the difference between "encrypted" and "assumed encrypted".
          written: updateMany.mock.calls,
        });

        expect(surface).not.toContain(CANARY);
        expect(surface).not.toContain('CANARY');
        expect(surface).not.toContain(ACTIVE_KEY.toString('base64'));
        expect(surface).not.toContain(OLD_KEY.toString('base64'));
      },
    );

    it('records the version change and nothing more in the audit entry', async () => {
      servePages([oldVersionRow()]);

      await service.rotateAll();

      expect(auditCreate).toHaveBeenCalledTimes(1);
      const data = (
        auditCreate.mock.calls[0][0] as unknown as {
          data: Record<string, unknown>;
        }
      ).data;

      expect(data).toMatchObject({
        action: 'managedSecret.reencrypt',
        resourceKey: SLOT,
        // No person did this, and inventing an actor would be a worse record.
        actorUserId: null,
        before: {
          kind: 'managedSecretSlot',
          configured: true,
          keyVersion: 'v1',
        },
        after: {
          kind: 'managedSecretSlot',
          configured: true,
          keyVersion: 'v2',
        },
      });
    });
  });

  /** The `data` of the single guarded update, as the row it would store. */
  function writtenData() {
    return updateManyArgs().data as unknown as {
      ciphertext: StoredBytes;
      iv: StoredBytes;
      authTag: StoredBytes;
      algorithm: string;
      keyFingerprint: string;
      keyVersion: string;
    };
  }

  function updateManyArgs() {
    expect(updateMany).toHaveBeenCalled();

    return updateMany.mock.calls[0][0] as unknown as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
  }
});
