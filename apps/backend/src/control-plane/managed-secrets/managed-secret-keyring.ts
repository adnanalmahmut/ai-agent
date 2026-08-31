import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { encryptionConfig } from '../../config';
import type { ManagedSecretKey } from './managed-secret.registry';
import {
  SECRET_ALGORITHM,
  SecretDecryptionError,
  type SealedSecret,
  fingerprintKey,
  openSecret,
  sealSecret,
} from './secret-cipher';

export type VersionedSealedSecret = SealedSecret & {
  keyVersion: string;
};

export type StoredManagedSecretCipher = Pick<
  SealedSecret,
  'ciphertext' | 'iv' | 'authTag' | 'algorithm' | 'keyFingerprint'
> & {
  keyVersion: string | null;
};

type StoredKeyMetadata = Pick<
  StoredManagedSecretCipher,
  'algorithm' | 'keyFingerprint' | 'keyVersion'
>;

/**
 * The application-owned key resolver for managed-secret ciphertext.
 *
 * It is intentionally narrow rather than a generic cryptography registry. The
 * only consumers are managed secrets, the only algorithm remains AES-256-GCM,
 * and the only compatibility shape is the null version written by the
 * preceding image.
 */
@Injectable()
export class ManagedSecretKeyring {
  private readonly keysByVersion: ReadonlyMap<string, Buffer>;

  constructor(
    @Inject(encryptionConfig.KEY)
    private readonly encryption: ConfigType<typeof encryptionConfig>,
  ) {
    this.keysByVersion = new Map([
      [encryption.activeKeyVersion, encryption.masterKey],
      ...encryption.decryptOnlyKeys.map(
        ({ version, key }) => [version, key] as const,
      ),
    ]);
  }

  /**
   * The version new writes are sealed under.
   *
   * Exposed because rotation has to ask "is this row already current?" without
   * decrypting it, and answering that from the row's own metadata is what the
   * version column is for. This is a non-secret identifier; the key material it
   * names stays private to this class.
   */
  get activeKeyVersion(): string {
    return this.encryption.activeKeyVersion;
  }

  seal(key: ManagedSecretKey, plaintext: string): VersionedSealedSecret {
    const keyVersion = this.encryption.activeKeyVersion;

    return {
      ...sealSecret(
        plaintext,
        this.encryption.masterKey,
        additionalAuthenticatedData(key, keyVersion),
      ),
      keyVersion,
    };
  }

  open(key: ManagedSecretKey, sealed: StoredManagedSecretCipher): string {
    const resolved = this.resolve(sealed);

    return openSecret(
      sealed,
      resolved.key,
      sealed.keyVersion === null
        ? undefined
        : additionalAuthenticatedData(key, resolved.version),
    );
  }

  /** Metadata-only usability check for list responses; never fetches a cipher. */
  canDecrypt(metadata: StoredKeyMetadata): boolean {
    if (metadata.algorithm !== SECRET_ALGORITHM) return false;

    try {
      this.resolve(metadata);
      return true;
    } catch {
      return false;
    }
  }

  private resolve(metadata: StoredKeyMetadata): {
    version: string;
    key: Buffer;
  } {
    if (metadata.keyVersion !== null) {
      const key = this.keysByVersion.get(metadata.keyVersion);

      if (key === undefined) {
        throw new SecretDecryptionError(
          'Stored secret references an unavailable encryption key version',
        );
      }

      if (fingerprintKey(key) !== metadata.keyFingerprint) {
        throw new SecretDecryptionError(
          'Stored secret encryption key version does not match its key fingerprint',
        );
      }

      return { version: metadata.keyVersion, key };
    }

    // Explicit preceding-image compatibility. A versioned row never reaches
    // this path, even when its recorded version is missing from configuration.
    const matches = [...this.keysByVersion.entries()].filter(
      ([, key]) => fingerprintKey(key) === metadata.keyFingerprint,
    );

    if (matches.length !== 1) {
      throw new SecretDecryptionError(
        'Stored pre-version secret does not match exactly one configured encryption key',
      );
    }

    const [[version, key]] = matches;
    return { version, key };
  }
}

function additionalAuthenticatedData(
  key: ManagedSecretKey,
  keyVersion: string,
): string {
  return `managed-secret:v1:${key}:${keyVersion}`;
}
