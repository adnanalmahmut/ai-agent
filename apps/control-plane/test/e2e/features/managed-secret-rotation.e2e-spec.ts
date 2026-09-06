import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { Test } from '@nestjs/testing';

import { RotationCliModule } from '../../../src/cli/rotation-cli.module';
import { ControlPlaneAuditService } from '../../../src/features/control-plane/audit/control-plane-audit.service';
import encryptionConfig from '../../../src/infrastructure/config/encryption.config';
import { ManagedSecretKeyring } from '../../../src/features/control-plane/managed-secrets/managed-secret-keyring';
import { ManagedSecretRotationService } from '../../../src/features/control-plane/managed-secrets/managed-secret-rotation.service';
import { sealSecret } from '../../../src/features/control-plane/managed-secrets/secret-cipher';
import { PrismaService } from '../../../src/infrastructure/database';

const ACTIVE_KEY = Buffer.alloc(32, 0xa1);
const OLD_KEY = Buffer.alloc(32, 0xb2);
const RETIRED_KEY = Buffer.alloc(32, 0xc3);
const SLOT = 'openai.api_key';
const CANARY = 'sk-CANARY-rotation-e2e-do-not-log-0000';

const encryption = {
  masterKey: ACTIVE_KEY,
  activeKeyVersion: 'e2e-v2',
  decryptOnlyKeys: [{ version: 'e2e-v1', key: OLD_KEY }],
} as unknown as ReturnType<typeof encryptionConfig>;

const aad = (version: string) => `managed-secret:v1:${SLOT}:${version}`;

describe('Managed secret key rotation (e2e)', () => {
  let prisma: PrismaService;
  let audit: ControlPlaneAuditService;
  let rotation: ManagedSecretRotationService;
  let keyring: ManagedSecretKeyring;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RotationCliModule],
    })
      .overrideProvider(encryptionConfig.KEY)
      .useValue(encryption)
      .compile();

    const context = await moduleRef.init();

    prisma = context.get(PrismaService);
    audit = context.get(ControlPlaneAuditService);
    rotation = context.get(ManagedSecretRotationService);
    keyring = context.get(ManagedSecretKeyring);
    close = () => context.close();
  }, 90_000);

  const clean = async () => {
    await prisma.controlPlaneAuditEvent.deleteMany({
      where: { resource: 'managedSecret' },
    });
    await prisma.managedSecret.deleteMany();
  };

  afterEach(clean);
  afterAll(async () => {
    await clean();
    await close?.();
  });

  const store = async (
    version: 'e2e-v1' | 'e2e-v2' | null,
    material: Buffer = version === 'e2e-v2' ? ACTIVE_KEY : OLD_KEY,
  ) => {
    const sealed =
      version === null
        ? sealSecret(CANARY, material)
        : sealSecret(CANARY, material, aad(version));

    return prisma.managedSecret.create({
      data: { key: SLOT, label: 'e2e', ...sealed, keyVersion: version },
    });
  };

  const row = () =>
    prisma.managedSecret.findUniqueOrThrow({ where: { key: SLOT } });

  it('re-encrypts an old-version row and leaves it readable', async () => {
    const before = await store('e2e-v1');

    const report = await rotation.rotateAll();

    expect(report).toMatchObject({ examined: 1, rotated: 1 });

    const after = await row();
    expect(after.keyVersion).toBe('e2e-v2');
    expect(Buffer.from(after.ciphertext)).not.toEqual(
      Buffer.from(before.ciphertext),
    );
    expect(keyring.open(SLOT, after)).toBe(CANARY);
    expect(after.lastRotatedAt).toEqual(before.lastRotatedAt);
    expect(after.label).toBe('e2e');
  });

  it('rolls the re-encryption back when its audit row cannot be written', async () => {
    const before = await store('e2e-v1');
    const failure = new Error('audit insert refused');
    const record = jest.spyOn(audit, 'record').mockRejectedValueOnce(failure);

    await expect(rotation.rotateAll()).rejects.toThrow(failure);

    record.mockRestore();

    const after = await row();
    expect(Buffer.from(after.ciphertext)).toEqual(
      Buffer.from(before.ciphertext),
    );
    expect(after.keyVersion).toBe('e2e-v1');
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(keyring.open(SLOT, after)).toBe(CANARY);
    expect(
      await prisma.controlPlaneAuditEvent.count({
        where: { action: 'managedSecret.reencrypt' },
      }),
    ).toBe(0);
  });

  it('migrates a pre-version row onto the active version', async () => {
    await store(null);

    await rotation.rotateAll();

    const after = await row();
    expect(after.keyVersion).toBe('e2e-v2');
    expect(keyring.open(SLOT, after)).toBe(CANARY);
  });

  it('is an exact no-op on a second run', async () => {
    await store('e2e-v1');
    await rotation.rotateAll();
    const afterFirst = await row();

    const report = await rotation.rotateAll();

    expect(report).toMatchObject({ examined: 1, rotated: 0, alreadyActive: 1 });
    expect(await row()).toEqual(afterFirst);
  });

  it('does not overwrite a row whose updatedAt moved after it was read', async () => {
    const stored = await store('e2e-v1');
    const staleReadAt = new Date(stored.updatedAt.getTime() - 3_600_000);

    const findMany = jest
      .spyOn(prisma.managedSecret, 'findMany')
      .mockImplementationOnce((() =>
        Promise.resolve([{ ...stored, updatedAt: staleReadAt }])) as never);

    try {
      const report = await rotation.rotateAll();

      expect(report).toMatchObject({
        examined: 1,
        rotated: 0,
        concurrentlyModified: 1,
      });
    } finally {
      findMany.mockRestore();
    }

    expect(await row()).toEqual(stored);
    expect(keyring.open(SLOT, await row())).toBe(CANARY);
    expect(
      await prisma.controlPlaneAuditEvent.count({
        where: { action: 'managedSecret.reencrypt' },
      }),
    ).toBe(0);
  });

  it('leaves a credential replaced before the sweep reached it', async () => {
    const stored = await store('e2e-v1');
    const replacement = sealSecret(
      'sk-operator-entered-this-one-instead',
      ACTIVE_KEY,
      aad('e2e-v2'),
    );

    const { count } = await prisma.managedSecret.updateMany({
      where: { key: SLOT, updatedAt: stored.updatedAt },
      data: { ...replacement, keyVersion: 'e2e-v2' },
    });
    expect(count).toBe(1);

    const report = await rotation.rotateAll();

    expect(report).toMatchObject({ rotated: 0, alreadyActive: 1 });
    expect(keyring.open(SLOT, await row())).toBe(
      'sk-operator-entered-this-one-instead',
    );
  });

  it('does not overwrite a row whose bytes moved under an unchanged updatedAt', async () => {
    const stored = await store('e2e-v1');
    const replacement = sealSecret(
      'sk-operator-entered-during-the-same-millisecond',
      ACTIVE_KEY,
      aad('e2e-v2'),
    );

    await prisma.$executeRaw`
      UPDATE "managed_secret"
      SET "ciphertext" = ${Buffer.from(replacement.ciphertext)},
          "iv" = ${Buffer.from(replacement.iv)},
          "authTag" = ${Buffer.from(replacement.authTag)},
          "keyFingerprint" = ${replacement.keyFingerprint},
          "keyVersion" = 'e2e-v2'
      WHERE "key" = ${SLOT}
    `;

    const moved = await row();
    expect(moved.updatedAt).toEqual(stored.updatedAt);

    const findMany = jest
      .spyOn(prisma.managedSecret, 'findMany')
      .mockImplementationOnce((() => Promise.resolve([stored])) as never);

    try {
      const report = await rotation.rotateAll();

      expect(report).toMatchObject({
        examined: 1,
        rotated: 0,
        concurrentlyModified: 1,
      });
    } finally {
      findMany.mockRestore();
    }

    expect(await row()).toEqual(moved);
    expect(keyring.open(SLOT, await row())).toBe(
      'sk-operator-entered-during-the-same-millisecond',
    );
    expect(
      await prisma.controlPlaneAuditEvent.count({
        where: { action: 'managedSecret.reencrypt' },
      }),
    ).toBe(0);
  });

  it('does not report a tampered active-version row as already current', async () => {
    const sealed = sealSecret(CANARY, ACTIVE_KEY, aad('e2e-v2'));
    const tampered = new Uint8Array(sealed.ciphertext);
    tampered[0] ^= 0xff;

    const before = await prisma.managedSecret.create({
      data: {
        key: SLOT,
        label: 'e2e',
        ...sealed,
        ciphertext: tampered,
        keyVersion: 'e2e-v2',
      },
    });

    const report = await rotation.rotateAll();

    expect(report).toMatchObject({
      examined: 1,
      unreadable: 1,
      alreadyActive: 0,
      rotated: 0,
    });
    expect(await row()).toEqual(before);

    const dry = await rotation.rotateAll({ dryRun: true });
    expect(dry).toMatchObject({
      unreadable: 1,
      alreadyActive: 0,
      wouldRotate: 0,
    });
  });

  it('leaves a row no configured key can read exactly as it was', async () => {
    const before = await store(null, RETIRED_KEY);

    const report = await rotation.rotateAll();

    expect(report).toMatchObject({ examined: 1, unreadable: 1, rotated: 0 });
    expect(await row()).toEqual(before);
  });

  it('writes nothing during a dry run', async () => {
    const before = await store('e2e-v1');

    const report = await rotation.rotateAll({ dryRun: true });

    expect(report).toMatchObject({ examined: 1, wouldRotate: 1, rotated: 0 });
    expect(await row()).toEqual(before);
    expect(
      await prisma.controlPlaneAuditEvent.count({
        where: { action: 'managedSecret.reencrypt' },
      }),
    ).toBe(0);
  });

  it('records the version change in the audit log and no credential', async () => {
    await store('e2e-v1');

    await rotation.rotateAll();

    const events = await prisma.controlPlaneAuditEvent.findMany({
      where: { action: 'managedSecret.reencrypt' },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      resource: 'managedSecret',
      resourceKey: SLOT,
      actorUserId: null,
    });
    expect(events[0].before).toMatchObject({ keyVersion: 'e2e-v1' });
    expect(events[0].after).toMatchObject({ keyVersion: 'e2e-v2' });
    expect(JSON.stringify(events)).not.toContain(CANARY);
    expect(JSON.stringify(events)).not.toContain('CANARY');
  });

  it('stores ciphertext that does not contain the credential', async () => {
    await store('e2e-v1');

    await rotation.rotateAll();

    const after = await row();
    expect(Buffer.from(after.ciphertext).toString('latin1')).not.toContain(
      CANARY,
    );
    expect(JSON.stringify(after)).not.toContain('CANARY');
  });

  it('reports an empty table without touching anything', async () => {
    const report = await rotation.rotateAll();

    expect(report).toMatchObject({ examined: 0, rotated: 0 });
  });
});
