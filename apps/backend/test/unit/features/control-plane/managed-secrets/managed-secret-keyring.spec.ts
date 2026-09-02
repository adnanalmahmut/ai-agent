import { describe, expect, it } from '@jest/globals';
import type { ConfigType } from '@nestjs/config';

import type { encryptionConfig } from '../../../../../src/infrastructure/config';
import type { ManagedSecretKey } from '../../../../../src/features/control-plane/managed-secrets/managed-secret.registry';
import {
  ManagedSecretKeyring,
  type StoredManagedSecretCipher,
} from '../../../../../src/features/control-plane/managed-secrets/managed-secret-keyring';
import {
  SecretDecryptionError,
  type StoredBytes,
  fingerprintKey,
  sealSecret,
} from '../../../../../src/features/control-plane/managed-secrets/secret-cipher';

const ACTIVE_KEY = Buffer.alloc(32, 0x11);
const OLD_KEY = Buffer.alloc(32, 0x22);
const WRONG_KEY = Buffer.alloc(32, 0x33);
const SECRET_KEY = 'openai.api_key' as const;
const OTHER_SLOT = 'other.api_key' as ManagedSecretKey;
const CANARY = 'sk-CANARY-keyring-do-not-log-0000000000';

const encryption: ConfigType<typeof encryptionConfig> = {
  masterKey: ACTIVE_KEY,
  activeKeyVersion: 'v2',
  decryptOnlyKeys: [{ version: 'v1', key: OLD_KEY }],
};

const keyring = new ManagedSecretKeyring(encryption);

const aad = (key: ManagedSecretKey, version: string) =>
  `managed-secret:v1:${key}:${version}`;

const oldVersionCipher = (): StoredManagedSecretCipher => ({
  ...sealSecret(CANARY, OLD_KEY, aad(SECRET_KEY, 'v1')),
  keyVersion: 'v1',
});

const legacyCipher = (key = OLD_KEY): StoredManagedSecretCipher => ({
  ...sealSecret(CANARY, key),
  keyVersion: null,
});

const flipByte = (bytes: StoredBytes): StoredBytes => {
  const copy = new Uint8Array(bytes);
  copy[0] ^= 0xff;
  return copy;
};

describe('ManagedSecretKeyring', () => {
  it('records the sole active version on every new write', () => {
    const sealed = keyring.seal(SECRET_KEY, CANARY);

    expect(sealed.keyVersion).toBe('v2');
    expect(keyring.open(SECRET_KEY, sealed)).toBe(CANARY);
  });

  it('decrypts an old version only through its exact decrypt-only key', () => {
    expect(keyring.open(SECRET_KEY, oldVersionCipher())).toBe(CANARY);
  });

  it('supports old and active key versions simultaneously', () => {
    const active = keyring.seal(SECRET_KEY, CANARY);
    const old = oldVersionCipher();

    expect(keyring.open(SECRET_KEY, active)).toBe(CANARY);
    expect(keyring.open(SECRET_KEY, old)).toBe(CANARY);
    expect(active.keyVersion).not.toBe(old.keyVersion);
  });

  it('never falls back from an unknown explicit version to the active key', () => {
    const sealed = keyring.seal(SECRET_KEY, CANARY);

    expect(() =>
      keyring.open(SECRET_KEY, { ...sealed, keyVersion: 'missing-v9' }),
    ).toThrow(/unavailable encryption key version/);
  });

  it('refuses a configured version whose key disagrees with the fingerprint', () => {
    const wrong = new ManagedSecretKeyring({
      ...encryption,
      decryptOnlyKeys: [{ version: 'v1', key: WRONG_KEY }],
    });

    expect(() => wrong.open(SECRET_KEY, oldVersionCipher())).toThrow(
      /does not match its key fingerprint/,
    );
  });

  it.each(['ciphertext', 'authTag'] as const)(
    'fails authentication when $component is altered',
    (component) => {
      const sealed = keyring.seal(SECRET_KEY, CANARY);

      expect(() =>
        keyring.open(SECRET_KEY, {
          ...sealed,
          [component]: flipByte(sealed[component]),
        }),
      ).toThrow(/failed authentication/);
    },
  );

  it('authenticates the managed-secret slot as AAD', () => {
    const sealed = keyring.seal(SECRET_KEY, CANARY);

    expect(() => keyring.open(OTHER_SLOT, sealed)).toThrow(
      /failed authentication/,
    );
  });

  it('authenticates the recorded key version as AAD', () => {
    const sharedMaterialKeyring = new ManagedSecretKeyring({
      masterKey: ACTIVE_KEY,
      activeKeyVersion: 'v3',
      // Constructed directly to probe the resolver. Boot configuration refuses
      // this duplicate material before a real process could reach the keyring.
      decryptOnlyKeys: [{ version: 'v2', key: ACTIVE_KEY }],
    });
    const sealed = keyring.seal(SECRET_KEY, CANARY);

    expect(() =>
      sharedMaterialKeyring.open(SECRET_KEY, {
        ...sealed,
        keyVersion: 'v3',
      }),
    ).toThrow(/failed authentication/);
  });

  it('opens a pre-version row by an exact fingerprint match without AAD', () => {
    expect(keyring.open(SECRET_KEY, legacyCipher())).toBe(CANARY);
  });

  it('opens a pre-version row written by the current active key', () => {
    expect(keyring.open(SECRET_KEY, legacyCipher(ACTIVE_KEY))).toBe(CANARY);
  });

  it('fails closed when a pre-version fingerprint matches no configured key', () => {
    expect(() => keyring.open(SECRET_KEY, legacyCipher(WRONG_KEY))).toThrow(
      /does not match exactly one configured encryption key/,
    );
  });

  /**
   * The configuration the first version-aware deployment actually runs under.
   *
   * Every legacy case above is proven against a keyring that has a decrypt-only
   * key configured, which is not the shape of the first rollout: there is no
   * older key yet, so `APP_ENCRYPTION_DECRYPT_KEYS` is empty and the one
   * configured key is the same material that sealed every existing row. That is
   * the configuration `docs/operations-runbook.md` instructs an operator to
   * deploy, so it is the one that has to be asserted — a legacy row must open
   * with the decrypt-only list empty, or the documented rollout reads every
   * stored credential as unusable on its first boot.
   */
  it('opens a pre-version row in the first-rollout configuration, with no decrypt-only keys', () => {
    const firstRollout = new ManagedSecretKeyring({
      masterKey: OLD_KEY,
      activeKeyVersion: 'v1',
      decryptOnlyKeys: [],
    });

    expect(firstRollout.open(SECRET_KEY, legacyCipher())).toBe(CANARY);
    expect(firstRollout.canDecrypt(legacyCipher())).toBe(true);
  });

  /**
   * A row the preceding image saved over during a rollback.
   *
   * That image writes the cipher columns without touching `keyVersion`, so the
   * row ends up carrying a version it was not sealed under and no AAD. Rolling
   * forward, the versioned branch is taken, the fingerprint agrees, AAD is
   * applied, and GCM refuses — while `canDecrypt`, which sees metadata only,
   * still answers true. Pinned here because the mismatch between those two
   * answers is what makes the failure confusing rather than obvious, and the
   * runbook's rollback guidance is written against exactly this shape. The
   * remedy is to re-enter the credential; it is deliberately not an AAD-less
   * retry, which would hand back the downgrade the binding exists to prevent.
   */
  it('fails closed, but still reports usable, for a versioned row an older image saved over', () => {
    const savedOverWhileRolledBack: StoredManagedSecretCipher = {
      ...sealSecret(CANARY, ACTIVE_KEY),
      keyVersion: 'v2',
    };

    expect(keyring.canDecrypt(savedOverWhileRolledBack)).toBe(true);
    expect(() => keyring.open(SECRET_KEY, savedOverWhileRolledBack)).toThrow(
      SecretDecryptionError,
    );
    expect(() => keyring.open(SECRET_KEY, savedOverWhileRolledBack)).toThrow(
      /failed authentication/,
    );
  });

  it('reports metadata usable only when algorithm, version, and fingerprint agree', () => {
    const active = keyring.seal(SECRET_KEY, CANARY);

    expect(keyring.canDecrypt(active)).toBe(true);
    expect(keyring.canDecrypt(oldVersionCipher())).toBe(true);
    expect(keyring.canDecrypt(legacyCipher())).toBe(true);
    expect(
      keyring.canDecrypt({ ...active, keyVersion: 'unknown-version' }),
    ).toBe(false);
    expect(keyring.canDecrypt({ ...active, algorithm: 'aes-128-cbc' })).toBe(
      false,
    );
    expect(keyring.canDecrypt(legacyCipher(WRONG_KEY))).toBe(false);
  });

  const surfaceOf = (error: unknown): string =>
    JSON.stringify({
      error,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

  const assertNoLeak = (attempt: () => string) => {
    let error: unknown;

    try {
      attempt();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(SecretDecryptionError);
    const surface = surfaceOf(error);
    expect(surface).not.toContain(CANARY);
    expect(surface).not.toContain(ACTIVE_KEY.toString('base64'));
    expect(surface).not.toContain(OLD_KEY.toString('base64'));
    expect(surface).not.toContain(WRONG_KEY.toString('base64'));
  };

  it('never includes plaintext or key material in a failure surface: an unknown recorded version', () => {
    const sealed = keyring.seal(SECRET_KEY, CANARY);

    assertNoLeak(() =>
      keyring.open(SECRET_KEY, { ...sealed, keyVersion: 'missing-v9' }),
    );
  });

  it('never includes plaintext or key material in a failure surface: a versioned row with the wrong fingerprint', () => {
    const sealed = keyring.seal(SECRET_KEY, CANARY);

    assertNoLeak(() =>
      keyring.open(SECRET_KEY, {
        ...sealed,
        keyFingerprint: fingerprintKey(WRONG_KEY),
      }),
    );
  });

  it('never includes plaintext or key material in a failure surface: a tampered ciphertext', () => {
    const sealed = keyring.seal(SECRET_KEY, CANARY);

    assertNoLeak(() =>
      keyring.open(SECRET_KEY, {
        ...sealed,
        ciphertext: flipByte(sealed.ciphertext),
      }),
    );
  });

  it('never includes plaintext or key material in a failure surface: a tampered auth tag', () => {
    const sealed = keyring.seal(SECRET_KEY, CANARY);

    assertNoLeak(() =>
      keyring.open(SECRET_KEY, {
        ...sealed,
        authTag: flipByte(sealed.authTag),
      }),
    );
  });

  it('never includes plaintext or key material in a failure surface: a pre-version row matching no configured key', () => {
    assertNoLeak(() => keyring.open(SECRET_KEY, legacyCipher(WRONG_KEY)));
  });
});
