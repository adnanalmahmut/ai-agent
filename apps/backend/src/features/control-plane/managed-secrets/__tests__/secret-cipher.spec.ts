import { describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';

import {
  SECRET_ALGORITHM,
  SecretDecryptionError,
  type SealedSecret,
  type StoredBytes,
  fingerprintKey,
  openSecret,
  sealSecret,
} from '../secret-cipher';

/**
 * The cryptography, tested for the properties that fail silently.
 *
 * Everything here is a promise the file's own comments make and that nothing
 * else in the system can check. A reused nonce still round-trips; a missing
 * fingerprint check still throws; a leaked plaintext still returns the right
 * answer. Each of those would pass a "does encryption work" test and be a
 * defect anyway, so every assertion below is about a property rather than
 * about the happy path.
 *
 * Every key is an obviously synthetic fill pattern and every plaintext is a
 * canary, so no value here could ever be mistaken for a real credential.
 */

/** Obviously fake 32-byte fill patterns; never generated, never real. */
const KEY_A = Buffer.alloc(32, 0xa1);
const KEY_B = Buffer.alloc(32, 0xb2);

/**
 * A plaintext that announces itself. Every leak assertion below searches for
 * this exact string, so a message that quoted any part of the secret would
 * have to quote something recognisable.
 */
const CANARY = 'sk-CANARY-do-not-log-0000000000';

/** Flips one byte, which is the smallest edit GCM has to notice. */
const flipByte = (bytes: StoredBytes, index = 0): StoredBytes => {
  const copy = new Uint8Array(bytes);
  copy[index] ^= 0xff;

  return copy;
};

const messageOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error('expected the call to throw, and it returned');
};

describe('secret cipher', () => {
  describe('sealSecret / openSecret', () => {
    it('returns the exact plaintext it was given', () => {
      const sealed = sealSecret(CANARY, KEY_A);

      expect(openSecret(sealed, KEY_A)).toBe(CANARY);
    });

    it('round-trips a multi-byte plaintext without corrupting it', () => {
      const plaintext = 'canary-ünïcødé-🔐-0000';

      expect(openSecret(sealSecret(plaintext, KEY_A), KEY_A)).toBe(plaintext);
    });

    it('records the algorithm and the key fingerprint on the sealed row', () => {
      const sealed = sealSecret(CANARY, KEY_A);

      expect(sealed.algorithm).toBe(SECRET_ALGORITHM);
      expect(sealed.keyFingerprint).toBe(fingerprintKey(KEY_A));
    });

    it('never stores the plaintext bytes in the ciphertext', () => {
      const sealed = sealSecret(CANARY, KEY_A);

      expect(Buffer.from(sealed.ciphertext).toString('utf8')).not.toContain(
        'CANARY',
      );
      expect(Buffer.from(sealed.ciphertext).toString('latin1')).not.toContain(
        CANARY,
      );
    });
  });

  /**
   * The single most important property in this file.
   *
   * A nonce reused under GCM does not weaken the scheme gradually — it leaks
   * the keystream and, with it, the authentication key. A hardcoded or derived
   * IV would pass every round-trip test ever written, so the only thing that
   * can catch it is an assertion that two encryptions of the *same* plaintext
   * under the *same* key differ.
   */
  describe('nonce freshness', () => {
    it('produces a different ciphertext each time it seals the same plaintext', () => {
      const first = sealSecret(CANARY, KEY_A);
      const second = sealSecret(CANARY, KEY_A);

      expect(Buffer.from(second.iv)).not.toEqual(Buffer.from(first.iv));
      expect(Buffer.from(second.ciphertext)).not.toEqual(
        Buffer.from(first.ciphertext),
      );
      expect(Buffer.from(second.authTag)).not.toEqual(
        Buffer.from(first.authTag),
      );

      // Both still open, so the difference is a fresh nonce and not damage.
      expect(openSecret(first, KEY_A)).toBe(CANARY);
      expect(openSecret(second, KEY_A)).toBe(CANARY);
    });

    it('never repeats a nonce across many seals of one plaintext', () => {
      const seals = Array.from({ length: 64 }, () => sealSecret(CANARY, KEY_A));
      const nonces = new Set(
        seals.map((sealed) => Buffer.from(sealed.iv).toString('hex')),
      );

      expect(nonces.size).toBe(seals.length);
    });

    it('uses the 12-byte nonce GCM expects', () => {
      expect(sealSecret(CANARY, KEY_A).iv).toHaveLength(12);
    });
  });

  /**
   * Authentication is the reason GCM was chosen over CTR: an edited row has to
   * be a loud failure rather than plausible garbage handed to a provider as a
   * credential. Each component is tampered with separately, because a check
   * that covered only the ciphertext would leave two doors open.
   */
  describe('tamper detection', () => {
    const cases: {
      component: keyof Pick<SealedSecret, 'ciphertext' | 'iv' | 'authTag'>;
    }[] = [
      { component: 'ciphertext' },
      { component: 'iv' },
      { component: 'authTag' },
    ];

    it.each(cases)(
      'rejects a row whose $component was edited',
      ({ component }) => {
        const sealed = sealSecret(CANARY, KEY_A);
        const altered = { ...sealed, [component]: flipByte(sealed[component]) };

        expect(() => openSecret(altered, KEY_A)).toThrow(SecretDecryptionError);
        expect(() => openSecret(altered, KEY_A)).toThrow(
          /failed authentication and may have been altered/,
        );
      },
    );

    it('rejects a truncated ciphertext', () => {
      const sealed = sealSecret(CANARY, KEY_A);
      const altered = {
        ...sealed,
        ciphertext: sealed.ciphertext.slice(0, 4),
      };

      expect(() => openSecret(altered, KEY_A)).toThrow(SecretDecryptionError);
    });

    /**
     * The downgrade this file exists to refuse.
     *
     * Node accepts 4, 8, and 12-16 byte GCM tags, and a short tag verifies
     * against a *prefix* of the correct one — so a row whose tag was cut to
     * four bytes decrypts successfully under stock `createDecipheriv`, with
     * forgery reduced to about 2^32 work. The lengths asserted below are the
     * ones Node would otherwise allow; every one of them must be refused
     * before the cipher sees the row.
     */
    it.each([4, 8, 12, 13, 14, 15])(
      'refuses a %i-byte authentication tag rather than verifying a prefix',
      (length) => {
        const sealed = sealSecret(CANARY, KEY_A);
        const altered = { ...sealed, authTag: sealed.authTag.slice(0, length) };

        expect(() => openSecret(altered, KEY_A)).toThrow(
          /malformed authentication tag/,
        );
      },
    );

    it('refuses a nonce that is not the length GCM was given', () => {
      const sealed = sealSecret(CANARY, KEY_A);

      expect(() =>
        openSecret({ ...sealed, iv: sealed.iv.slice(0, 8) }, KEY_A),
      ).toThrow(/malformed nonce/);
    });
  });

  /**
   * The two diagnoses must stay distinguishable.
   *
   * GCM cannot tell "wrong key" from "edited row" — both are an authentication
   * failure — and the responses differ: one means re-enter the credential, the
   * other means the row was altered. Collapsing them sends an operator to the
   * wrong place, so this asserts both the message that is produced and the
   * message that is not.
   */
  describe('wrong master key', () => {
    it('reports a different master key rather than a tampered row', () => {
      const sealed = sealSecret(CANARY, KEY_A);

      const message = messageOf(() => openSecret(sealed, KEY_B));

      expect(message).toMatch(/different master key/);
      expect(message).not.toMatch(/failed authentication/);
      expect(() => openSecret(sealed, KEY_B)).toThrow(SecretDecryptionError);
    });

    it('still reports a tampered row when the key is the right one', () => {
      const sealed = sealSecret(CANARY, KEY_A);
      const altered = { ...sealed, ciphertext: flipByte(sealed.ciphertext) };

      const message = messageOf(() => openSecret(altered, KEY_A));

      expect(message).toMatch(/failed authentication/);
      expect(message).not.toMatch(/different master key/);
    });
  });

  describe('algorithm', () => {
    it('refuses a row sealed with an algorithm this build does not support', () => {
      const sealed = sealSecret(CANARY, KEY_A);
      const altered = { ...sealed, algorithm: 'aes-128-cbc' };

      expect(() => openSecret(altered, KEY_A)).toThrow(SecretDecryptionError);
      expect(() => openSecret(altered, KEY_A)).toThrow(
        /unsupported algorithm aes-128-cbc/,
      );
    });

    /**
     * Checked before anything else, so a row from a future algorithm says so
     * instead of reporting the key or the authentication as the problem.
     */
    it('refuses an unsupported algorithm ahead of the fingerprint check', () => {
      const sealed = sealSecret(CANARY, KEY_A);
      const altered = {
        ...sealed,
        algorithm: 'aes-128-cbc',
        keyFingerprint: 'not-the-current-fingerprint',
      };

      expect(messageOf(() => openSecret(altered, KEY_A))).toMatch(
        /unsupported algorithm/,
      );
    });
  });

  describe('fingerprintKey', () => {
    it('is stable for one key', () => {
      expect(fingerprintKey(KEY_A)).toBe(fingerprintKey(KEY_A));
      expect(fingerprintKey(Buffer.alloc(32, 0xa1))).toBe(
        fingerprintKey(KEY_A),
      );
    });

    it('differs across keys', () => {
      expect(fingerprintKey(KEY_B)).not.toBe(fingerprintKey(KEY_A));
    });

    it('is a short hex digest rather than key material', () => {
      const fingerprint = fingerprintKey(KEY_A);

      expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(KEY_A.toString('hex')).not.toContain(fingerprint);
      expect(KEY_A.toString('base64')).not.toContain(fingerprint);
    });

    /**
     * Two rounds, not one. A single digest of the key is still a digest of the
     * key, and this value is stored in a table the control plane reads.
     */
    it('is not a plain digest of the key material', () => {
      const single = createSingleDigest(KEY_A);

      expect(fingerprintKey(KEY_A)).not.toBe(single.slice(0, 16));
    });
  });

  /**
   * No error this module raises may carry the credential it failed on. The
   * messages are written by hand for exactly this reason, and Node's own —
   * which sit next to the plaintext buffer — are swallowed rather than
   * re-raised.
   */
  describe('error messages', () => {
    it('never quotes the plaintext on any failure path', () => {
      const sealed = sealSecret(CANARY, KEY_A);

      const messages = [
        messageOf(() => openSecret(sealed, KEY_B)),
        messageOf(() =>
          openSecret(
            { ...sealed, ciphertext: flipByte(sealed.ciphertext) },
            KEY_A,
          ),
        ),
        messageOf(() =>
          openSecret({ ...sealed, iv: flipByte(sealed.iv) }, KEY_A),
        ),
        messageOf(() =>
          openSecret({ ...sealed, authTag: flipByte(sealed.authTag) }, KEY_A),
        ),
        messageOf(() =>
          openSecret({ ...sealed, algorithm: 'aes-128-cbc' }, KEY_A),
        ),
      ];

      for (const message of messages) {
        expect(message).not.toContain(CANARY);
        expect(message).toEqual(expect.not.stringMatching(/CANARY/i));
        expect(message).not.toContain(KEY_A.toString('base64'));
        expect(message).not.toContain(KEY_A.toString('hex'));
      }
    });

    it('is thrown as a named error a caller can branch on', () => {
      const sealed = sealSecret(CANARY, KEY_A);

      try {
        openSecret(sealed, KEY_B);
        throw new Error('expected the call to throw, and it returned');
      } catch (error) {
        expect(error).toBeInstanceOf(SecretDecryptionError);
        expect((error as Error).name).toBe('SecretDecryptionError');
      }
    });
  });
});

/** A single SHA-256 of the key, to prove the fingerprint is not that. */
function createSingleDigest(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex');
}
