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

const oldVersionRow = (key = SLOT): Row => ({
  key,
  ...sealSecret(CANARY, OLD_KEY, aad('v1')),
  keyVersion: 'v1',
  updatedAt: READ_AT,
});

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
    $transaction: (work: (tx: unknown) => Promise<unknown>) => work(prisma),
  } as unknown as PrismaService;

  const keyring = new ManagedSecretKeyring(encryption);
  let service: ManagedSecretRotationService;

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
      expect(keyring.open(SLOT, { ...written, keyVersion: 'v2' })).toBe(CANARY);
    });

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
    it('never overwrites a row that changed while it was being rotated', async () => {
      servePages([oldVersionRow()]);
      updateMany.mockResolvedValue({ count: 0 });

      const report = await service.rotateAll();

      expect(report).toMatchObject({
        examined: 1,
        rotated: 0,
        concurrentlyModified: 1,
      });
      expect(auditCreate).not.toHaveBeenCalled();
    });

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

    it('continues past an unreadable row', async () => {
      servePages([{ ...oldVersionRow(), keyVersion: 'v9' }], [oldVersionRow()]);

      const report = await service.rotateAll({ batchSize: 1 });

      expect(report).toMatchObject({ examined: 2, unreadable: 1, rotated: 1 });
    });

    it('refuses a row whose slot this build does not define', async () => {
      servePages([{ ...oldVersionRow('retired.api_key') }]);

      const report = await service.rotateAll();

      expect(report).toMatchObject({ examined: 1, unknownSlot: 1, rotated: 0 });
      expect(updateMany).not.toHaveBeenCalled();
    });

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
      expect(second).toMatchObject({ where: { key: { gt: 'b' } } });
    });

    it('visits every row across several pages exactly once', async () => {
      servePages(
        [oldVersionRow('a'), oldVersionRow('b')],
        [oldVersionRow('c')],
      );

      const report = await service.rotateAll({ batchSize: 2 });

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

    it('reports an unreadable row as unreadable, not as rotatable', async () => {
      servePages([legacyRow(SLOT, RETIRED_KEY)]);

      const report = await service.rotateAll({ dryRun: true });

      expect(report).toMatchObject({ unreadable: 1, wouldRotate: 0 });
    });

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
      ['a dry run', () => servePages([oldVersionRow()]), { dryRun: true }],
    ])(
      'is absent from the report and the audit payload: %s',
      async (_label, arrange, options) => {
        arrange();

        const report = await service.rotateAll(options);

        const surface = JSON.stringify({
          report,
          audit: auditCreate.mock.calls,
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
