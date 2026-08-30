import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

/**
 * The algorithm, recorded on every row.
 *
 * Stored rather than assumed so that changing it later is a migration with a
 * readable path — rows say what they were encrypted with — instead of a flag
 * day where every existing ciphertext becomes undecryptable at once.
 */
export const SECRET_ALGORITHM = 'aes-256-gcm';

/** GCM's standard nonce length. Not the block size; not negotiable per row. */
const IV_BYTES = 12;

/**
 * GCM's full tag length, and the only one this build will accept.
 *
 * Node permits 4, 8, and 12-16 byte tags, and — this is the part that matters —
 * verification of a short tag succeeds against a *prefix* of the correct one.
 * A row is written by an operator through the control plane, but the column is
 * still reachable by anything with database write access, and a tag truncated
 * to four bytes turns forging a credential from infeasible into roughly 2^32
 * work. Both the length and `authTagLength` are therefore pinned: the explicit
 * check rejects the row, and the option means a future edit that drops the
 * check still cannot silently accept a short tag.
 */
const AUTH_TAG_BYTES = 16;

/**
 * `Uint8Array`, not `Buffer`, because that is what the `Bytes` column is.
 *
 * Prisma types a `Bytes` field as `Uint8Array<ArrayBuffer>`. Neither Node's
 * `Buffer` nor a bare `Uint8Array` satisfies that — both are
 * `Uint8Array<ArrayBufferLike>` — so the argument has to be written out.
 * Converting at the persistence boundary would mean every call site
 * remembering to; making the cipher speak the storage type means none of them
 * can forget. Node's crypto accepts a `Uint8Array` wherever it accepts a
 * `Buffer`, so nothing else has to change.
 */
export type StoredBytes = Uint8Array<ArrayBuffer>;

export type SealedSecret = {
  ciphertext: StoredBytes;
  iv: StoredBytes;
  authTag: StoredBytes;
  algorithm: string;
  keyFingerprint: string;
};

/** Copies into a fresh `ArrayBuffer`, which is what makes the type exact. */
function toStorageBytes(value: Buffer): StoredBytes {
  return new Uint8Array(value);
}

/**
 * A non-secret identifier for the master key that encrypted a row.
 *
 * Two rounds of SHA-256 truncated to 16 hex characters. It exists so that
 * decrypting with the wrong key produces a stated diagnosis rather than a bare
 * authentication failure, which is indistinguishable from a corrupted row and
 * sends an operator looking in the wrong place. Double hashing is cheap and
 * means the stored value is not a plain digest of the key material.
 */
export function fingerprintKey(masterKey: Buffer): string {
  const once = createHash('sha256').update(masterKey).digest();

  return createHash('sha256').update(once).digest('hex').slice(0, 16);
}

/** Raised when a stored secret cannot be turned back into its plaintext. */
export class SecretDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretDecryptionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Encrypts a secret for storage.
 *
 * AES-256-GCM rather than CBC or CTR because it authenticates: a row someone
 * has edited in the database fails loudly on read instead of decrypting to
 * plausible garbage that would then be sent to a provider as a credential.
 *
 * A fresh random IV per call, never derived and never reused. Nonce reuse under
 * GCM is not a gradual weakening — it leaks the keystream and, with it, the
 * authentication key. This is the single most important line in the file, which
 * is why it is generated here rather than accepted as a parameter.
 */
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

/**
 * Recovers a stored secret.
 *
 * Every failure is deliberately turned into a `SecretDecryptionError` carrying
 * an application-owned message. Node's own errors on this path are terse
 * ("Unsupported state or unable to authenticate data") and, worse, a raw throw
 * from here would travel up through whatever provider adapter asked for the
 * credential and could be logged beside it.
 */
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

  /**
   * Checked before attempting the decryption, because the two failures need
   * different responses and GCM cannot tell them apart: a wrong key means the
   * deployment's `APP_ENCRYPTION_KEY` changed and the secret must be re-entered,
   * while a genuine authentication failure on the right key means the row was
   * altered.
   */
  const fingerprint = fingerprintKey(masterKey);

  if (sealed.keyFingerprint !== fingerprint) {
    throw new SecretDecryptionError(
      'Stored secret was encrypted with a different master key; re-enter the credential through the control plane',
    );
  }

  /**
   * Lengths are structural, so they are asserted rather than left to the
   * cipher. A wrong nonce length is a corrupted row; a short authentication
   * tag is a downgrade, and neither should reach `createDecipheriv`.
   */
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
