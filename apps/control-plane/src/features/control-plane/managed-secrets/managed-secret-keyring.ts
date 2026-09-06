import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { encryptionConfig } from '../../../infrastructure/config';
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
