import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { ConfigType } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';

import type { encryptionConfig } from '../../../../../src/infrastructure/config';
import { AppException } from '../../../../../src/core/errors';
import type { PrismaService } from '../../../../../src/infrastructure/database';
import { Prisma } from '../../../../../src/generated/prisma/client';
import { ControlPlaneAuditService } from '../../../../../src/features/control-plane/audit/control-plane-audit.service';
import {
  ManagedSecretKeyring,
  type StoredManagedSecretCipher,
} from '../../../../../src/features/control-plane/managed-secrets/managed-secret-keyring';
import { ManagedSecretService } from '../../../../../src/features/control-plane/managed-secrets/managed-secret.service';
import {
  SECRET_ALGORITHM,
  type StoredBytes,
  fingerprintKey,
  sealSecret,
} from '../../../../../src/features/control-plane/managed-secrets/secret-cipher';

/**
 * The credential store, tested for what it must never do.
 *
 * The happy path here is one row and one AES call, and it is not what makes
 * this class worth testing. What makes it worth testing is that a plaintext
 * must not reach a read surface, an error message, a public detail, or any
 * log — including on the failure paths, which is exactly where a value tends
 * to get attached to an error "for debugging". So every failure path below is
 * driven with the same canary string and the result is searched for it.
 *
 * The registry is the real one, because its `validate` is part of the
 * behaviour under test and there is nothing about it that a synthetic entry
 * would express better.
 */

/** An obviously fake 32-byte fill pattern, never generated and never real. */
const MASTER_KEY = Buffer.alloc(32, 0x5a);
/** A second, equally fake key, standing in for "the deployment key changed". */
const ROTATED_AWAY_KEY = Buffer.alloc(32, 0x6b);

const encryption: ConfigType<typeof encryptionConfig> = {
  masterKey: MASTER_KEY,
  activeKeyVersion: 'v2',
  decryptOnlyKeys: [],
};
const keyring = new ManagedSecretKeyring(encryption);

/**
 * Valid enough for the registry to accept and unmistakable in any output. If
 * this string ever appears in a response, an error, or a log line, that is the
 * defect this file exists to catch.
 */
const CANARY = 'sk-CANARY-do-not-log-0000000000';

const KEY = 'openai.api_key' as const;

const ACTOR_ID = 'user-operator-1';

const UPDATED_AT = new Date('2026-02-01T00:00:00.000Z');
const ROTATED_AT = new Date('2026-02-02T00:00:00.000Z');

/** The metadata columns `describeAll` is allowed to read. */
type MetadataRow = {
  key: string;
  label: string | null;
  algorithm: string;
  keyFingerprint: string;
  keyVersion: string | null;
  lastRotatedAt: Date;
  updatedAt: Date;
};

const metadataRow = (overrides: Partial<MetadataRow> = {}): MetadataRow => ({
  key: KEY,
  label: 'primary',
  algorithm: SECRET_ALGORITHM,
  keyFingerprint: fingerprintKey(MASTER_KEY),
  keyVersion: 'v2',
  lastRotatedAt: ROTATED_AT,
  updatedAt: UPDATED_AT,
  ...overrides,
});

type CipherRow = StoredManagedSecretCipher;

const cipherRow = (plaintext = CANARY, key: Buffer = MASTER_KEY): CipherRow => {
  if (key.equals(MASTER_KEY)) return keyring.seal(KEY, plaintext);

  const { ciphertext, iv, authTag, algorithm, keyFingerprint } = sealSecret(
    plaintext,
    key,
  );

  return {
    ciphertext,
    iv,
    authTag,
    algorithm,
    keyFingerprint,
    // A pre-version row: exactly how a key rotated out of configuration
    // entirely (not even decrypt-only) shows up once versioning exists.
    keyVersion: null,
  };
};

const flipByte = (bytes: StoredBytes): StoredBytes => {
  const copy = new Uint8Array(bytes);
  copy[0] ^= 0xff;

  return copy;
};

/** Everything a caller could observe about a thrown error, as one string. */
const surfaceOf = (error: unknown): string =>
  JSON.stringify({
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : undefined,
    stack: error instanceof Error ? error.stack : undefined,
    ownProperties: error,
  });

const rejectionOf = async (run: () => Promise<unknown>): Promise<unknown> =>
  run().then(
    () => {
      throw new Error('expected the call to reject, and it resolved');
    },
    (thrown: unknown) => thrown,
  );

describe('ManagedSecretService', () => {
  const findMany = jest.fn<(args: unknown) => Promise<MetadataRow[]>>();
  const findUnique = jest.fn<(args: unknown) => Promise<CipherRow | null>>();
  const upsert = jest.fn<(args: unknown) => Promise<unknown>>();
  const deleteMany = jest.fn<(args: unknown) => Promise<{ count: number }>>();

  /**
   * The audit write, captured rather than stubbed away.
   *
   * The real `ControlPlaneAuditService` is constructed over this fake, so the
   * canary assertions below search the payload the service actually builds.
   */
  const auditCreate = jest.fn<(args: unknown) => Promise<unknown>>();

  const prisma = {
    managedSecret: { findMany, findUnique, upsert, deleteMany },
    controlPlaneAuditEvent: { create: auditCreate },
    /** One client for both writes; that they commit together is an e2e claim. */
    $transaction: (work: (tx: unknown) => Promise<unknown>) => work(prisma),
  } as unknown as PrismaService;

  /** Everything the audit log was handed, as one searchable string. */
  const auditedText = () => JSON.stringify(auditCreate.mock.calls);

  const auditRow = () =>
    (auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> })?.data;

  const warn = jest.fn<(...args: unknown[]) => void>();
  const logger = { warn } as unknown as PinoLogger;

  /**
   * The injected logger is spied on above; these catch the other way a value
   * reaches a log — a stray `console` call on a failure path — and are
   * asserted to have stayed silent.
   */
  const consoleSpies = ['log', 'info', 'warn', 'error', 'debug'] as const;
  let consoleCalls: unknown[][];

  /** Everything handed to the logger, as one searchable string. */
  const loggedText = () => JSON.stringify(warn.mock.calls);

  let service: ManagedSecretService;

  /** The data object handed to `upsert.create` on the last write. */
  const createdRow = () =>
    (
      upsert.mock.calls[0]?.[0] as {
        create: CipherRow & { label: string | null; updatedByUserId: string };
      }
    ).create;

  beforeEach(() => {
    findMany.mockReset().mockResolvedValue([]);
    findUnique.mockReset().mockResolvedValue(null);
    upsert.mockReset().mockResolvedValue({});
    deleteMany.mockReset().mockResolvedValue({ count: 1 });
    warn.mockReset();
    auditCreate.mockReset().mockResolvedValue({});

    consoleCalls = [];
    for (const method of consoleSpies) {
      jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleCalls.push(args);
      });
    }

    service = new ManagedSecretService(
      prisma,
      new ControlPlaneAuditService(prisma),
      keyring,
      logger,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * The read surface has no field a plaintext or a ciphertext could occupy,
   * and that is asserted as a property of the returned shape rather than as
   * "the value we happened to check is absent".
   */
  describe('describeAll', () => {
    it('describes an unconfigured slot without inventing one', async () => {
      const [entry] = await service.describeAll();

      expect(entry).toEqual({
        key: KEY,
        description: expect.any(String),
        configured: false,
        label: undefined,
        algorithm: undefined,
        keyVersion: undefined,
        lastRotatedAt: undefined,
        updatedAt: undefined,
        usable: false,
      });
    });

    it('returns metadata only, with no field that could hold the credential', async () => {
      findMany.mockResolvedValue([metadataRow()]);

      const [entry] = await service.describeAll();

      expect(Object.keys(entry).sort()).toEqual([
        'algorithm',
        'configured',
        'description',
        'key',
        'keyVersion',
        'label',
        'lastRotatedAt',
        'updatedAt',
        'usable',
      ]);
      for (const forbidden of [
        'ciphertext',
        'iv',
        'authTag',
        'value',
        'plaintext',
        'secret',
        'keyFingerprint',
      ]) {
        expect(entry).not.toHaveProperty(forbidden);
      }
    });

    /**
     * The query itself, not just its result. A `findMany` that pulled the
     * encrypted material into memory for a listing endpoint would be a leak
     * waiting for the first `console.log` of a row, even if this method never
     * returned it.
     */
    it('never selects the encrypted material for a listing', async () => {
      await service.describeAll();

      const select = (
        findMany.mock.calls[0]?.[0] as { select: Record<string, unknown> }
      ).select;

      expect(select).toBeDefined();
      expect(select).not.toHaveProperty('ciphertext');
      expect(select).not.toHaveProperty('iv');
      expect(select).not.toHaveProperty('authTag');
    });

    it('reports a configured slot sealed with the current key as usable', async () => {
      findMany.mockResolvedValue([metadataRow()]);

      const [entry] = await service.describeAll();

      expect(entry).toMatchObject({
        configured: true,
        usable: true,
        label: 'primary',
        algorithm: SECRET_ALGORITHM,
        keyVersion: 'v2',
        lastRotatedAt: ROTATED_AT,
        updatedAt: UPDATED_AT,
      });
    });

    /**
     * The whole reason the fingerprint is stored. Without this an operator
     * discovers a changed `APP_ENCRYPTION_KEY` as an unexplained provider
     * outage rather than as a row the control plane says to re-enter.
     */
    it('reports a slot sealed with a different master key as configured but unusable', async () => {
      findMany.mockResolvedValue([
        metadataRow({ keyFingerprint: fingerprintKey(ROTATED_AWAY_KEY) }),
      ]);

      const [entry] = await service.describeAll();

      expect(entry.configured).toBe(true);
      expect(entry.usable).toBe(false);
    });

    it('treats an absent row as unusable rather than as usable-by-default', async () => {
      const [entry] = await service.describeAll();

      expect(entry.usable).toBe(false);
    });
  });

  describe('set', () => {
    it('encrypts the value and stores no plaintext', async () => {
      findMany.mockResolvedValue([metadataRow()]);

      await service.set({
        key: KEY,
        value: CANARY,
        label: 'primary',
        actorUserId: 'user-1',
      });

      const created = createdRow();

      expect(created.algorithm).toBe(SECRET_ALGORITHM);
      expect(created.keyFingerprint).toBe(fingerprintKey(MASTER_KEY));
      expect(created.keyVersion).toBe('v2');
      expect(created.label).toBe('primary');
      expect(created.updatedByUserId).toBe('user-1');
      expect(Buffer.from(created.ciphertext).toString('latin1')).not.toContain(
        CANARY,
      );
      expect(JSON.stringify(upsert.mock.calls)).not.toContain('CANARY');
      // The stored material is the value, recoverable only with the key.
      expect(keyring.open(KEY, created)).toBe(CANARY);
    });

    it('produces different stored material each time it writes the same value', async () => {
      await service.set({ key: KEY, value: CANARY, actorUserId: 'user-1' });
      await service.set({ key: KEY, value: CANARY, actorUserId: 'user-1' });

      const [first, second] = upsert.mock.calls.map(
        (call) => (call[0] as { create: CipherRow }).create,
      );

      expect(Buffer.from(second.iv)).not.toEqual(Buffer.from(first.iv));
      expect(Buffer.from(second.ciphertext)).not.toEqual(
        Buffer.from(first.ciphertext),
      );
    });

    it.each([
      { label: 'too short to be a credential', value: 'sk-CANARY-short' },
      {
        label: "another provider's key",
        value: 'CANARY-wrong-prefix-00000000',
      },
      { label: 'padded with whitespace', value: ` ${CANARY} ` },
    ])('refuses a value that is $label', async ({ value }) => {
      const error = await rejectionOf(() =>
        service.set({ key: KEY, value, actorUserId: 'user-1' }),
      );

      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).code).toBe('VALIDATION_ERROR');
      expect(typeof (error as AppException).publicDetails?.reason).toBe(
        'string',
      );
      expect((error as AppException).context).toEqual({ secretKey: KEY });
      expect(upsert).not.toHaveBeenCalled();
    });

    it('describes the required shape without quoting the submitted value', async () => {
      const error = await rejectionOf(() =>
        service.set({
          key: KEY,
          value: 'sk-CANARY-short',
          actorUserId: 'user-1',
        }),
      );

      expect(surfaceOf(error)).not.toContain('CANARY');
    });

    /**
     * Rotation is `set` with a new value, and the operator pasting a new key
     * has no reason to retype the note that says which account it belongs to.
     * Writing `null` for an omitted label would erase it on every rotation,
     * from the only surface that shows it, without saying so.
     */
    it('leaves an existing label alone when a rotation omits it', async () => {
      await service.set({ key: KEY, value: CANARY, actorUserId: 'user-1' });

      const { update } = upsert.mock.calls[0]?.[0] as {
        update: Record<string, unknown>;
      };

      expect(update).not.toHaveProperty('label');
    });

    it('replaces the label when a rotation supplies one', async () => {
      await service.set({
        key: KEY,
        value: CANARY,
        label: 'billing account',
        actorUserId: 'user-1',
      });

      const { update } = upsert.mock.calls[0]?.[0] as {
        update: Record<string, unknown>;
      };

      expect(update).toMatchObject({ label: 'billing account' });
    });
  });

  describe('remove', () => {
    it('deletes the row and reports the slot as unconfigured', async () => {
      const description = await service.remove({
        key: KEY,
        actorUserId: ACTOR_ID,
      });

      expect(deleteMany).toHaveBeenCalledWith({ where: { key: KEY } });
      expect(description).toMatchObject({ configured: false, usable: false });
    });
  });

  describe('reveal', () => {
    it('returns the plaintext for the adapter that asked', async () => {
      findUnique.mockResolvedValue(cipherRow());

      await expect(service.reveal(KEY)).resolves.toBe(CANARY);
    });

    it('reports SECRET_NOT_CONFIGURED when nothing is stored', async () => {
      const error = await rejectionOf(() => service.reveal(KEY));

      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).code).toBe('SECRET_NOT_CONFIGURED');
      expect((error as AppException).context).toEqual({ secretKey: KEY });
    });

    it('reports SECRET_UNREADABLE when the stored row was altered', async () => {
      const row = cipherRow();
      findUnique.mockResolvedValue({
        ...row,
        ciphertext: flipByte(row.ciphertext),
      });

      const error = await rejectionOf(() => service.reveal(KEY));

      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).code).toBe('SECRET_UNREADABLE');
      expect((error as AppException).context).toMatchObject({
        secretKey: KEY,
        reason: expect.stringContaining('failed authentication'),
      });
    });

    /**
     * The operator-facing diagnosis has to survive the re-wrap. "Re-enter the
     * credential" and "the row was altered" call for different actions, and
     * the application error carries the cipher's own message precisely so the
     * distinction is not lost at the boundary.
     *
     * This is the legacy (pre-version) shape: a row written before key-version
     * metadata existed, sealed under a key that has since been rotated out of
     * configuration entirely (not even decrypt-only). Its stored fingerprint
     * therefore matches nothing configured.
     */
    it('carries the legacy-row diagnosis through as internal context when its key was rotated out of configuration', async () => {
      findUnique.mockResolvedValue(cipherRow(CANARY, ROTATED_AWAY_KEY));

      const error = await rejectionOf(() => service.reveal(KEY));

      expect((error as AppException).code).toBe('SECRET_UNREADABLE');
      expect((error as AppException).context).toMatchObject({
        reason: expect.stringContaining(
          'does not match exactly one configured encryption key',
        ),
      });
    });

    /**
     * The realistic operational counterpart to the legacy case above: a
     * versioned row whose recorded key version is configured, but whose
     * fingerprint does not match that version's key material — e.g. the
     * environment was reconfigured without bumping the version, or the row
     * was corrupted. The keyring must refuse this exactly like any other
     * unreadable row, never by falling back to the active key.
     */
    it('reports SECRET_UNREADABLE when a versioned row disagrees with its recorded key fingerprint', async () => {
      findUnique.mockResolvedValue({
        ...cipherRow(),
        keyFingerprint: fingerprintKey(ROTATED_AWAY_KEY),
      });

      const error = await rejectionOf(() => service.reveal(KEY));

      expect((error as AppException).code).toBe('SECRET_UNREADABLE');
      expect((error as AppException).context).toMatchObject({
        reason: expect.stringContaining('does not match its key fingerprint'),
      });
    });

    it('reports SECRET_UNREADABLE when a row records a key version that is not configured', async () => {
      findUnique.mockResolvedValue({
        ...cipherRow(),
        keyVersion: 'unknown-v9',
      });

      const error = await rejectionOf(() => service.reveal(KEY));

      expect((error as AppException).code).toBe('SECRET_UNREADABLE');
      expect((error as AppException).context).toMatchObject({
        reason: expect.stringContaining('unavailable encryption key version'),
      });
    });

    it('reports SECRET_UNREADABLE for a row sealed with an unsupported algorithm', async () => {
      findUnique.mockResolvedValue({
        ...cipherRow(),
        algorithm: 'aes-128-cbc',
      });

      const error = await rejectionOf(() => service.reveal(KEY));

      expect((error as AppException).code).toBe('SECRET_UNREADABLE');
      expect((error as AppException).context).toMatchObject({
        reason: expect.stringContaining('unsupported algorithm'),
      });
    });

    it('never returns the plaintext as part of a public detail', async () => {
      findUnique.mockResolvedValue(cipherRow(CANARY, ROTATED_AWAY_KEY));

      const error = await rejectionOf(() => service.reveal(KEY));

      expect((error as AppException).publicDetails).toBeUndefined();
    });
  });

  /**
   * The canary sweep.
   *
   * Every path that can fail while a credential is in scope, driven with the
   * same recognisable value, and one assertion applied to all of them: the
   * value appears in nothing a caller, an operator, or a log aggregator will
   * ever see. Individually these are covered above; together they are the
   * property, and the property is what must not regress.
   */
  describe('the canary appears nowhere', () => {
    const failures: {
      label: string;
      arrange: () => void;
      act: (service: ManagedSecretService) => Promise<unknown>;
    }[] = [
      {
        label: 'a value the registry rejects',
        arrange: () => undefined,
        act: (service) =>
          service.set({
            key: KEY,
            value: `${CANARY} `,
            actorUserId: 'user-1',
          }),
      },
      {
        label: 'a row sealed with a different master key',
        arrange: () =>
          findUnique.mockResolvedValue(cipherRow(CANARY, ROTATED_AWAY_KEY)),
        act: (service) => service.reveal(KEY),
      },
      {
        label: 'a row whose ciphertext was altered',
        arrange: () => {
          const row = cipherRow();
          findUnique.mockResolvedValue({
            ...row,
            ciphertext: flipByte(row.ciphertext),
          });
        },
        act: (service) => service.reveal(KEY),
      },
      {
        label: 'a row whose authentication tag was altered',
        arrange: () => {
          const row = cipherRow();
          findUnique.mockResolvedValue({
            ...row,
            authTag: flipByte(row.authTag),
          });
        },
        act: (service) => service.reveal(KEY),
      },
      {
        label: 'a row sealed with an unsupported algorithm',
        arrange: () =>
          findUnique.mockResolvedValue({
            ...cipherRow(),
            algorithm: 'aes-128-cbc',
          }),
        act: (service) => service.reveal(KEY),
      },
      {
        label: 'a slot that is not configured at all',
        arrange: () => undefined,
        act: (service) => service.reveal(KEY),
      },
    ];

    it.each(failures)(
      'does not leak it through $label',
      async ({ arrange, act }) => {
        arrange();

        const error = await rejectionOf(() => act(service));

        expect(surfaceOf(error)).not.toContain(CANARY);
        expect(surfaceOf(error)).not.toContain('CANARY');
        expect((error as AppException).publicDetails ?? {}).toEqual(
          expect.not.objectContaining({ value: expect.anything() }),
        );
        expect(
          JSON.stringify((error as AppException).publicDetails ?? {}),
        ).not.toContain('CANARY');
        expect(JSON.stringify(consoleCalls)).not.toContain('CANARY');
        expect(consoleCalls).toEqual([]);
        expect(loggedText()).not.toContain(CANARY);
        expect(loggedText()).not.toContain('CANARY');
      },
    );

    /**
     * The diagnosis has to be logged, not merely attached to an exception.
     *
     * A key fingerprint is stored precisely so "the deployment key changed"
     * and "this row was altered" stay distinguishable, and the caller renders
     * both as the same unavailable-credential error. If the reason never
     * reaches an operator-visible log, the column earns nothing.
     */
    it.each([
      {
        label: 'a legacy row whose key was rotated out of configuration',
        arrange: () =>
          findUnique.mockResolvedValue(cipherRow(CANARY, ROTATED_AWAY_KEY)),
        expected: /does not match exactly one configured encryption key/,
      },
      {
        label: 'a versioned row that disagrees with its key fingerprint',
        arrange: () =>
          findUnique.mockResolvedValue({
            ...cipherRow(),
            keyFingerprint: fingerprintKey(ROTATED_AWAY_KEY),
          }),
        expected: /does not match its key fingerprint/,
      },
      {
        label: 'a row recording an unconfigured key version',
        arrange: () =>
          findUnique.mockResolvedValue({
            ...cipherRow(),
            keyVersion: 'unknown-v9',
          }),
        expected: /unavailable encryption key version/,
      },
      {
        label: 'an altered row',
        arrange: () => {
          const row = cipherRow();
          findUnique.mockResolvedValue({
            ...row,
            ciphertext: flipByte(row.ciphertext),
          });
        },
        expected: /failed authentication/,
      },
    ])(
      'records why the secret was unreadable: $label',
      async ({ arrange, expected }) => {
        arrange();

        await rejectionOf(() => service.reveal(KEY));

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          { secretKey: KEY, reason: expect.stringMatching(expected) },
          expect.any(String),
        );
      },
    );

    it('says nothing at all when the secret reads back cleanly', async () => {
      findUnique.mockResolvedValue(cipherRow());

      await expect(service.reveal(KEY)).resolves.toBe(CANARY);

      expect(warn).not.toHaveBeenCalled();
    });

    it('does not leak it through the read surface of a configured slot', async () => {
      findMany.mockResolvedValue([metadataRow()]);

      const described = await service.describeAll();

      expect(JSON.stringify(described)).not.toContain('CANARY');
      expect(consoleCalls).toEqual([]);
    });
  });

  /**
   * The audit log is a new place a credential could end up, and unlike the
   * process log it has a read surface — every `controlPlane:read` holder can
   * page through it. The canary is pushed through every mutation and the whole
   * payload is searched, rather than asserting on the fields the projection
   * happens to build today.
   */
  describe('audit', () => {
    it('records a first configuration without any credential material', async () => {
      findUnique.mockResolvedValue(null);

      await service.set({
        key: KEY,
        value: CANARY,
        label: 'primary account',
        actorUserId: ACTOR_ID,
      });

      expect(auditedText()).not.toContain(CANARY);
      // Every fragment of the sealed row, by name. A projection that spread the
      // row instead of naming three columns would fail here rather than in
      // production.
      for (const field of ['ciphertext', 'iv', 'authTag', 'keyFingerprint']) {
        expect(auditRow()).not.toHaveProperty(`after.${field}`);
      }

      expect(auditRow()).toMatchObject({
        action: 'managedSecret.configure',
        resource: 'managedSecret',
        resourceKey: KEY,
        actorUserId: ACTOR_ID,
        after: { kind: 'managedSecretSlot', configured: true },
      });
      expect(auditRow()?.before).toBe(Prisma.DbNull);
    });

    /**
     * Rotation is a distinct action from first configuration even though it is
     * the same call. "This slot has never held a credential" is the fact an
     * incident asks about, and collapsing the two would lose it.
     */
    it('records a rotation as a rotation', async () => {
      findUnique.mockResolvedValue(
        metadataRow({ label: 'primary account' }) as never,
      );

      await service.set({ key: KEY, value: CANARY, actorUserId: ACTOR_ID });

      expect(auditedText()).not.toContain(CANARY);
      expect(auditRow()).toMatchObject({
        action: 'managedSecret.rotate',
        before: { kind: 'managedSecretSlot', configured: true },
        after: { kind: 'managedSecretSlot', configured: true },
      });
    });

    it('records a removal as leaving the slot unconfigured', async () => {
      findUnique.mockResolvedValue(metadataRow() as never);

      await service.remove({ key: KEY, actorUserId: ACTOR_ID });

      expect(auditedText()).not.toContain(CANARY);
      expect(auditRow()).toMatchObject({
        action: 'managedSecret.remove',
        after: { kind: 'managedSecretSlot', configured: false },
      });
    });

    /**
     * A refused credential must leave no trace saying it was configured. The
     * value is refused before anything is sealed, so an audit row here would
     * report a configuration that never happened.
     */
    it('writes nothing when the credential is refused', async () => {
      await expect(
        service.set({ key: KEY, value: 'not-a-key', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(AppException);

      expect(auditCreate).not.toHaveBeenCalled();
    });
  });
});
