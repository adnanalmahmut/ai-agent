import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

export const SECRET_ALGORITHM = 'aes-256-gcm';

const IV_BYTES = 12;

const AUTH_TAG_BYTES = 16;

export type StoredBytes = Uint8Array<ArrayBuffer>;

export type SealedSecret = {
  ciphertext: StoredBytes;
  iv: StoredBytes;
  authTag: StoredBytes;
  algorithm: string;
  keyFingerprint: string;
};

function toStorageBytes(value: Buffer): StoredBytes {
  return new Uint8Array(value);
}

export function fingerprintKey(masterKey: Buffer): string {
  const once = createHash('sha256').update(masterKey).digest();

  return createHash('sha256').update(once).digest('hex').slice(0, 16);
}

export class SecretDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretDecryptionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function sealSecret(
  plaintext: string,
  masterKey: Buffer,
  additionalAuthenticatedData?: string,
): SealedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(SECRET_ALGORITHM, masterKey, iv);

  if (additionalAuthenticatedData !== undefined) {
    // Node requires AAD before the first update. It is authenticated, not
    // encrypted, and contains only application-owned identifiers.
    cipher.setAAD(Buffer.from(additionalAuthenticatedData, 'utf8'));
  }

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  return {
    ciphertext: toStorageBytes(ciphertext),
    iv: toStorageBytes(iv),
    authTag: toStorageBytes(cipher.getAuthTag()),
    algorithm: SECRET_ALGORITHM,
    keyFingerprint: fingerprintKey(masterKey),
  };
}

export function openSecret(
  sealed: Pick<
    SealedSecret,
    'ciphertext' | 'iv' | 'authTag' | 'algorithm' | 'keyFingerprint'
  >,
  masterKey: Buffer,
  additionalAuthenticatedData?: string,
): string {
  if (sealed.algorithm !== SECRET_ALGORITHM) {
    throw new SecretDecryptionError(
      `Stored secret uses unsupported algorithm ${sealed.algorithm}`,
    );
  }

  const fingerprint = fingerprintKey(masterKey);

  if (sealed.keyFingerprint !== fingerprint) {
    throw new SecretDecryptionError(
      'Stored secret was encrypted with a different master key; re-enter the credential through the control plane',
    );
  }

  if (sealed.iv.length !== IV_BYTES) {
    throw new SecretDecryptionError(
      'Stored secret has a malformed nonce and may have been altered',
    );
  }

  if (sealed.authTag.length !== AUTH_TAG_BYTES) {
    throw new SecretDecryptionError(
      'Stored secret has a malformed authentication tag and may have been altered',
    );
  }

  try {
    const decipher = createDecipheriv(SECRET_ALGORITHM, masterKey, sealed.iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAuthTag(sealed.authTag);

    if (additionalAuthenticatedData !== undefined) {
      decipher.setAAD(Buffer.from(additionalAuthenticatedData, 'utf8'));
    }

    return Buffer.concat([
      decipher.update(sealed.ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Never the underlying error. It carries no useful detail for an operator
    // and this call sits directly beside credential material.
    throw new SecretDecryptionError(
      'Stored secret failed authentication and may have been altered',
    );
  }
}
