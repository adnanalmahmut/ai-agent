import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * Why this one stays in the environment.
 *
 * Everything else the control plane manages lives in PostgreSQL, which is the
 * point of having a control plane. This value cannot: it is what decrypts the
 * rows, so storing it beside them would encrypt nothing. It is bootstrap
 * configuration in the same sense as `DATABASE_URL` — needed before the
 * database is useful — and belongs in the root-owned runtime environment file
 * that the application reads at boot and never writes.
 *
 * 32 bytes because AES-256-GCM takes a 256-bit key. Base64 rather than hex or
 * raw text so the value is unambiguous in a `KEY=value` file and so a truncated
 * paste fails at boot instead of producing a short key that silently weakens
 * every secret.
 */
const REQUIRED_KEY_BYTES = 32;
const MAX_KEY_VERSION_LENGTH = 64;
const MAX_DECRYPT_ONLY_KEYS = 16;
const MAX_DECRYPT_KEYS_ENV_LENGTH = 4096;

const keyVersionSchema = z
  .string()
  .min(1, 'encryption key version is required')
  .max(
    MAX_KEY_VERSION_LENGTH,
    `encryption key version must be at most ${MAX_KEY_VERSION_LENGTH} characters`,
  )
  .regex(
    /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/,
    'encryption key version must use lowercase letters, digits, dot, underscore, or hyphen and must not end with punctuation',
  );

const encodedKeySchema = z
  .string()
  .min(1, 'APP_ENCRYPTION_KEY is required')
  .refine(
    isCanonicalEncryptionKey,
    `APP_ENCRYPTION_KEY must be ${REQUIRED_KEY_BYTES} bytes encoded as base64 (generate with: openssl rand -base64 ${REQUIRED_KEY_BYTES})`,
  );

const schema = z.object({
  APP_ENCRYPTION_KEY: encodedKeySchema,
  APP_ENCRYPTION_ACTIVE_KEY_VERSION: keyVersionSchema,
  APP_ENCRYPTION_DECRYPT_KEYS: z
    .string()
    .max(
      MAX_DECRYPT_KEYS_ENV_LENGTH,
      `APP_ENCRYPTION_DECRYPT_KEYS must be at most ${MAX_DECRYPT_KEYS_ENV_LENGTH} characters`,
    )
    .default(''),
});

export type ConfiguredEncryptionKey = Readonly<{
  version: string;
  key: Buffer;
}>;

export type EncryptionConfig = {
  /**
   * The master key as bytes.
   *
   * Decoded once at boot rather than on each use, so a malformed value is a
   * startup failure an operator sees immediately instead of a runtime failure
   * on the first secret read — which, for a credential, would surface as an
   * unexplained provider outage.
   */
  masterKey: Buffer;
  /** Stable, non-secret identity recorded on every new ciphertext row. */
  activeKeyVersion: string;
  /** Older key versions available for exact-version decryption only. */
  decryptOnlyKeys: readonly ConfiguredEncryptionKey[];
};

export default registerAs('encryption', (): EncryptionConfig => {
  const env = schema.parse(process.env);
  const decryptOnlyKeys = parseDecryptOnlyKeys(
    env.APP_ENCRYPTION_DECRYPT_KEYS,
    env.APP_ENCRYPTION_ACTIVE_KEY_VERSION,
    env.APP_ENCRYPTION_KEY,
  );

  return {
    masterKey: Buffer.from(env.APP_ENCRYPTION_KEY, 'base64'),
    activeKeyVersion: env.APP_ENCRYPTION_ACTIVE_KEY_VERSION,
    decryptOnlyKeys,
  };
});

function isCanonicalEncryptionKey(value: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;

  const decoded = Buffer.from(value, 'base64');

  return (
    decoded.length === REQUIRED_KEY_BYTES &&
    decoded.toString('base64') === value
  );
}

/**
 * Parses `version=base64,version=base64` without ever placing a submitted key
 * in an exception. The delimiter is safe because a version cannot contain `=`
 * and base64 padding appears only at the end of its value.
 */
function parseDecryptOnlyKeys(
  raw: string,
  activeVersion: string,
  activeEncodedKey: string,
): readonly ConfiguredEncryptionKey[] {
  if (raw === '') return Object.freeze([]);

  const entries = raw.split(',');

  if (entries.length > MAX_DECRYPT_ONLY_KEYS) {
    throw new Error(
      `APP_ENCRYPTION_DECRYPT_KEYS may contain at most ${MAX_DECRYPT_ONLY_KEYS} entries`,
    );
  }

  const versions = new Set<string>();
  const encodedKeys = new Set<string>([activeEncodedKey]);
  const parsed = entries.map((entry, index): ConfiguredEncryptionKey => {
    const separator = entry.indexOf('=');
    const version = separator === -1 ? '' : entry.slice(0, separator);
    const encodedKey = separator === -1 ? '' : entry.slice(separator + 1);
    const position = index + 1;

    if (!keyVersionSchema.safeParse(version).success) {
      throw new Error(
        `APP_ENCRYPTION_DECRYPT_KEYS entry ${position} has an invalid version`,
      );
    }

    if (!isCanonicalEncryptionKey(encodedKey)) {
      throw new Error(
        `APP_ENCRYPTION_DECRYPT_KEYS entry ${position} must contain a canonical base64-encoded 32-byte key`,
      );
    }

    if (version === activeVersion) {
      throw new Error(
        'APP_ENCRYPTION_DECRYPT_KEYS must not repeat APP_ENCRYPTION_ACTIVE_KEY_VERSION',
      );
    }

    if (versions.has(version)) {
      throw new Error(
        `APP_ENCRYPTION_DECRYPT_KEYS contains duplicate version at entry ${position}`,
      );
    }

    if (encodedKeys.has(encodedKey)) {
      throw new Error(
        `APP_ENCRYPTION_DECRYPT_KEYS reuses key material at entry ${position}`,
      );
    }

    versions.add(version);
    encodedKeys.add(encodedKey);

    return Object.freeze({
      version,
      key: Buffer.from(encodedKey, 'base64'),
    });
  });

  return Object.freeze(parsed);
}
