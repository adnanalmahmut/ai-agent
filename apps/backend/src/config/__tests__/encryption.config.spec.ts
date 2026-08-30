import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import encryptionConfig from '../encryption.config';

/**
 * The one control-plane value that cannot live in the control plane.
 *
 * The factory runs during `ConfigModule` init, so "does this throw" is the same
 * question as "does the process start" — and a key that is the wrong length is
 * far better as a boot failure than as an AES call that fails on the first
 * credential read, months later, wearing the costume of a provider outage.
 *
 * Every value below is an obviously synthetic fill pattern. Nothing here is or
 * resembles a real key.
 */

/** A 32-byte fill pattern, base64-encoded exactly as an operator would paste it. */
const VALID_KEY = Buffer.alloc(32, 0x2b).toString('base64');
const OLD_KEY = Buffer.alloc(32, 0x3c).toString('base64');
const OLDER_KEY = Buffer.alloc(32, 0x4d).toString('base64');

/**
 * A recognisable non-key. The point of using it is the last assertion in this
 * file: a rejection message must describe the required shape and must not
 * repeat what was submitted, because the submitted value is a key often enough
 * that echoing it into a boot log is a leak.
 */
const CANARY = 'CANARY-not-a-real-key-do-not-log';

describe('encryptionConfig', () => {
  const original = process.env;

  beforeEach(() => {
    process.env = { ...original };
    delete process.env.APP_ENCRYPTION_KEY;
    process.env.APP_ENCRYPTION_ACTIVE_KEY_VERSION = 'v2';
    process.env.APP_ENCRYPTION_DECRYPT_KEYS = '';
  });

  afterEach(() => {
    process.env = original;
  });

  it('decodes a valid base64 32-byte key into bytes', () => {
    process.env.APP_ENCRYPTION_KEY = VALID_KEY;

    const { masterKey, activeKeyVersion, decryptOnlyKeys } = encryptionConfig();

    expect(Buffer.isBuffer(masterKey)).toBe(true);
    expect(masterKey).toHaveLength(32);
    expect(masterKey.equals(Buffer.from(VALID_KEY, 'base64'))).toBe(true);
    expect(activeKeyVersion).toBe('v2');
    expect(decryptOnlyKeys).toEqual([]);
  });

  it('decodes once at boot rather than handing on the encoded string', () => {
    process.env.APP_ENCRYPTION_KEY = VALID_KEY;

    expect(encryptionConfig().masterKey.toString('base64')).toBe(VALID_KEY);
    expect(encryptionConfig().masterKey.toString('utf8')).not.toBe(VALID_KEY);
  });

  /**
   * AES-256 takes a 256-bit key and nothing else. A shorter value would not
   * "work a bit less well" — `createCipheriv` would reject it at the point of
   * use, which is the worst possible time to find out.
   */
  it.each([
    { label: '16 bytes', value: Buffer.alloc(16, 0x11).toString('base64') },
    { label: '31 bytes', value: Buffer.alloc(31, 0x11).toString('base64') },
    { label: '33 bytes', value: Buffer.alloc(33, 0x11).toString('base64') },
    { label: '64 bytes', value: Buffer.alloc(64, 0x11).toString('base64') },
  ])('refuses a key of $label', ({ value }) => {
    process.env.APP_ENCRYPTION_KEY = value;

    expect(() => encryptionConfig()).toThrow(/32 bytes encoded as base64/);
  });

  /** The failure the encoding was chosen to catch: a paste that lost its tail. */
  it('refuses a truncated paste of an otherwise valid key', () => {
    process.env.APP_ENCRYPTION_KEY = VALID_KEY.slice(0, VALID_KEY.length - 8);

    expect(() => encryptionConfig()).toThrow(/32 bytes encoded as base64/);
  });

  it('refuses a value that is not base64 at all', () => {
    process.env.APP_ENCRYPTION_KEY = CANARY;

    expect(() => encryptionConfig()).toThrow(/32 bytes encoded as base64/);
  });

  it('refuses an empty value', () => {
    process.env.APP_ENCRYPTION_KEY = '';

    expect(() => encryptionConfig()).toThrow(/APP_ENCRYPTION_KEY is required/);
  });

  it('refuses a missing variable', () => {
    expect(() => encryptionConfig()).toThrow(/APP_ENCRYPTION_KEY/);
  });

  it('parses distinct decrypt-only key versions without changing the active key', () => {
    process.env.APP_ENCRYPTION_KEY = VALID_KEY;
    process.env.APP_ENCRYPTION_DECRYPT_KEYS = `v1=${OLD_KEY},legacy-2025=${OLDER_KEY}`;

    const config = encryptionConfig();

    expect(config.activeKeyVersion).toBe('v2');
    expect(config.masterKey.toString('base64')).toBe(VALID_KEY);
    expect(
      config.decryptOnlyKeys.map(({ version, key }) => ({
        version,
        key: key.toString('base64'),
      })),
    ).toEqual([
      { version: 'v1', key: OLD_KEY },
      { version: 'legacy-2025', key: OLDER_KEY },
    ]);
  });

  it('refuses a missing active version', () => {
    process.env.APP_ENCRYPTION_KEY = VALID_KEY;
    delete process.env.APP_ENCRYPTION_ACTIVE_KEY_VERSION;

    expect(() => encryptionConfig()).toThrow(
      /APP_ENCRYPTION_ACTIVE_KEY_VERSION/,
    );
  });

  it.each(['V2', '-v2', 'v2-', 'v 2', 'v2/active'])(
    'refuses malformed active version %s',
    (version) => {
      process.env.APP_ENCRYPTION_KEY = VALID_KEY;
      process.env.APP_ENCRYPTION_ACTIVE_KEY_VERSION = version;

      expect(() => encryptionConfig()).toThrow(/encryption key version/);
    },
  );

  it('refuses duplicate decrypt-only versions', () => {
    process.env.APP_ENCRYPTION_KEY = VALID_KEY;
    process.env.APP_ENCRYPTION_DECRYPT_KEYS = `v1=${OLD_KEY},v1=${OLDER_KEY}`;

    expect(() => encryptionConfig()).toThrow(/duplicate version/);
  });

  it('refuses the active version in the decrypt-only list', () => {
    process.env.APP_ENCRYPTION_KEY = VALID_KEY;
    process.env.APP_ENCRYPTION_DECRYPT_KEYS = `v2=${OLD_KEY}`;

    expect(() => encryptionConfig()).toThrow(/must not repeat/);
  });

  it('refuses key material reused under another version', () => {
    process.env.APP_ENCRYPTION_KEY = VALID_KEY;
    process.env.APP_ENCRYPTION_DECRYPT_KEYS = `v1=${VALID_KEY}`;

    expect(() => encryptionConfig()).toThrow(/reuses key material/);
  });

  it('refuses malformed decrypt-only key material without echoing it', () => {
    process.env.APP_ENCRYPTION_KEY = VALID_KEY;
    process.env.APP_ENCRYPTION_DECRYPT_KEYS = `v1=${CANARY}`;

    let message = '';
    try {
      encryptionConfig();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/canonical base64-encoded 32-byte key/);
    expect(message).not.toContain(CANARY);
  });

  /**
   * A boot failure is logged, and the value that caused it is a key. The
   * message may name the variable and state the required shape; it may not
   * repeat the submission.
   */
  it('never echoes the submitted value in the rejection', () => {
    const submissions = [CANARY, '', Buffer.alloc(16, 0x11).toString('base64')];

    for (const submission of submissions) {
      process.env.APP_ENCRYPTION_KEY = submission;

      let message = '';
      try {
        encryptionConfig();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).not.toBe('');
      expect(message).not.toContain('CANARY');
      if (submission !== '') expect(message).not.toContain(submission);
    }
  });

  it('names the variable and the remedy so an operator can act on it', () => {
    process.env.APP_ENCRYPTION_KEY = CANARY;

    expect(() => encryptionConfig()).toThrow(/APP_ENCRYPTION_KEY/);
    expect(() => encryptionConfig()).toThrow(/openssl rand -base64 32/);
  });
});
