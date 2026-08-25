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

const schema = z.object({
  APP_ENCRYPTION_KEY: z
    .string()
    .min(1, 'APP_ENCRYPTION_KEY is required')
    .refine((value) => {
      try {
        return Buffer.from(value, 'base64').length === REQUIRED_KEY_BYTES;
      } catch {
        return false;
      }
    }, `APP_ENCRYPTION_KEY must be ${REQUIRED_KEY_BYTES} bytes encoded as base64 (generate with: openssl rand -base64 ${REQUIRED_KEY_BYTES})`),
});

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
};

export default registerAs('encryption', (): EncryptionConfig => {
  const env = schema.parse(process.env);

  return { masterKey: Buffer.from(env.APP_ENCRYPTION_KEY, 'base64') };
});
