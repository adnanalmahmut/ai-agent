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

import { RotationCliModule } from '../../src/cli/rotation-cli.module';
import encryptionConfig from '../../src/config/encryption.config';
import { ManagedSecretKeyring } from '../../src/control-plane/managed-secrets/managed-secret-keyring';
import { ManagedSecretRotationService } from '../../src/control-plane/managed-secrets/managed-secret-rotation.service';
import { sealSecret } from '../../src/control-plane/managed-secrets/secret-cipher';
import { PrismaService } from '../../src/database';

/**
 * Rotation against a real PostgreSQL row.
 *
 * The unit spec drives the decisions over a fake Prisma; this is the only place
 * that can show the parts a fake cannot: that the guarded `updateMany` really
 * does match on `updatedAt`, that a losing compare-and-swap leaves the stored
 * bytes untouched, and that the audit row and the secret row commit together.
 *
 * The keyring here is built over a literal configuration rather than the
 * process environment, so this suite can hold two key versions at once — which
 * is the whole situation rotation exists for and which the e2e environment,
 * with its single `test-v1`, cannot express.
 */

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
  let rotation: ManagedSecretRotationService;
  let keyring: ManagedSecretKeyring;
  let close: () => Promise<void>;

  beforeAll(async () => {
    /**
     * The real composition root, with only the key material overridden.
     *
     * Building the providers by hand would test a graph nobody deploys; this
     * way the suite also proves `RotationCliModule` itself resolves — which is
     * the failure an operator would meet first, and which no unit test can see.
     * The override exists because the e2e environment configures a single key
     * version, and rotation is by definition about holding two.
     */
    const moduleRef = await Test.createTestingModule({
      imports: [RotationCliModule],
    })
      .overrideProvider(encryptionConfig.KEY)
      .useValue(encryption)
      .compile();

    // `init` is what runs the lifecycle hooks, notably Prisma's connect.
    const context = await moduleRef.init();

    prisma = context.get(PrismaService);
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

  /** Writes a row exactly as the named key version would have written it. */
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
    // The credential itself did not change, so the bookkeeping that says it did
    // must not move either.
    expect(after.lastRotatedAt).toEqual(before.lastRotatedAt);
    expect(after.label).toBe('e2e');
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

  /**
   * The claim the compare-and-swap exists for, driven against the real column.
   *
   * The interleaving that matters cannot be produced by writing before the
   * sweep starts: the row would simply be current by the time it is read, and
   * the sweep would skip it without ever reaching the guarded update — a test
   * that passes with the guard deleted. What has to be reproduced is a *stale
   * read*, so the read is what gets faked. The sweep sees the row as it was an
   * hour ago, decides to rotate it, and issues its update against a row the
   * database has since moved on from.
   *
   * With `updatedAt` removed from the update's `where`, this test fails: the
   * update matches, and the credential an operator entered mid-sweep is
   * silently replaced by a re-encryption of the value it retired.
   */
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

    // The row the database actually holds is untouched, byte for byte.
    expect(await row()).toEqual(stored);
    expect(keyring.open(SLOT, await row())).toBe(CANARY);
    // And a losing swap left no audit entry claiming it rotated.
    expect(
      await prisma.controlPlaneAuditEvent.count({
        where: { action: 'managedSecret.reencrypt' },
      }),
    ).toBe(0);
  });

  /**
   * The other half of the same claim: a credential an operator replaces before
   * the sweep reaches it is simply current, and rotation leaves their value
   * alone rather than reverting it.
   */
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

  /**
   * The other half of the compare-and-swap, and the half the stale-`updatedAt`
   * test above cannot reach.
   *
   * `updatedAt` is a `timestamp(3)` that Prisma stamps in JavaScript, so two
   * writes to one row inside the same millisecond compare equal and the guard
   * would match a row it must refuse. Reproducing that timing reliably is not
   * possible; reproducing its *effect* is — the row's bytes move while the
   * timestamp the sweep read stays valid. The raw statement is what makes that
   * expressible at all, since any Prisma write would advance `updatedAt` and
   * quietly turn this back into the previous test.
   *
   * With `ciphertext` removed from the update's `where`, this test fails: the
   * guard matches on the timestamp alone and the concurrent value is lost.
   */
  it('does not overwrite a row whose bytes moved under an unchanged updatedAt', async () => {
    const stored = await store('e2e-v1');
    const replacement = sealSecret(
      'sk-operator-entered-during-the-same-millisecond',
      ACTIVE_KEY,
      aad('e2e-v2'),
    );

    // Raw, so `updatedAt` keeps the value the sweep is about to be handed.
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

    // The sweep is handed the row as it was before that write.
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

    // The concurrent value is what the table still holds.
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

  /**
   * An active-version row that cannot actually be opened.
   *
   * Its version column and its key fingerprint both still agree with the active
   * key — they describe the key, not the bytes — so nothing short of an
   * authenticated decryption can tell this row apart from a healthy one. Counting
   * it as already current is how step D reports "nothing left to rotate" over a
   * row no key can read, and step F then deletes the old key.
   */
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

    // And the dry run — the gate an operator actually reads — agrees.
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
