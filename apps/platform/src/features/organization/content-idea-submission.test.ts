import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearPendingSubmission,
  digestOf,
  keyForSubmission,
  readPendingSubmission,
  writePendingSubmission,
} from './content-idea-submission';
import type { ContentIdeaRequest } from './organization-api';

/**
 * The record that survives a reload, and what it is allowed to contain.
 *
 * Two claims are being made here and they are separable. The first is
 * behavioral: the same material request reuses the key it was already sent
 * with, and a materially different one does not. The second is a containment
 * claim: what reaches `sessionStorage` is an opaque digest and an identifier,
 * never the operator's request. The behavior tests would all pass against the
 * previous implementation, which stored the request verbatim — so the
 * containment assertions are the ones that would catch a revert.
 */

const STORAGE_KEY = 'content-idea:pending:org_1';

/**
 * Deliberately recognizable, and deliberately the kind of thing a marketing
 * request actually carries: an unannounced product, a launch date, a customer
 * segment. If any of it can be read back out of the browser, this feature has
 * written the organization's plans somewhere nobody asked it to.
 */
const REQUEST: ContentIdeaRequest = {
  topic: 'Project Nightjar, unannounced',
  goal: 'Warm the list before the 14 March launch',
  language: 'en',
  audience: 'Lapsed enterprise buyers in DACH',
  guidance: 'Do not mention the recall',
  numberOfIdeas: 5,
};

const SECRETS = [
  'Nightjar',
  '14 March',
  'Lapsed enterprise buyers in DACH',
  'Do not mention the recall',
];

/** Everything this origin's session storage holds, keys and values alike. */
const storageDump = () =>
  Object.entries({ ...window.sessionStorage })
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('\n');

let minted = 0;
const mint = () => `key_${(minted += 1)}`;

beforeEach(() => {
  window.sessionStorage.clear();
  minted = 0;
});

describe('digestOf', () => {
  /**
   * Pinned to a literal rather than recomputed in the test.
   *
   * Recomputing it here would only prove the test agrees with itself: the
   * canonical form — sorted keys, dropped `undefined` — would change silently
   * along with the implementation, and a record digested by one build would
   * stop matching one written by another. The literal is what makes the
   * canonical form part of the contract.
   */
  it('is SHA-256 of the canonical rendering, as lowercase hex', async () => {
    await expect(
      digestOf({
        topic: 'Electric kettles',
        goal: 'Sell the autumn range',
        language: 'en',
        numberOfIdeas: 5,
      }),
    ).resolves.toBe(
      '157dd97358212f41c8a48c170de0307f4f30ae5f3ef46fb31553ea120a9655c0',
    );
  });

  it('does not depend on the order the request was assembled in', async () => {
    const [first, second] = await Promise.all([
      digestOf({
        topic: 'Kettles',
        goal: 'Sell more',
        language: 'en',
        numberOfIdeas: 3,
      }),
      digestOf({
        numberOfIdeas: 3,
        language: 'en',
        goal: 'Sell more',
        topic: 'Kettles',
      } as ContentIdeaRequest),
    ]);

    expect(first).toBe(second);
  });

  /**
   * "No audience" and "audience omitted" are the same request. Serializing an
   * explicit `undefined` as `null` would digest them apart and mint a second
   * key — and a second billed run — for a form the reader never touched.
   */
  it('treats an explicitly undefined field as an absent one', async () => {
    const [omitted, explicit] = await Promise.all([
      digestOf({
        topic: 'Kettles',
        goal: 'Sell more',
        language: 'en',
        numberOfIdeas: 3,
      }),
      digestOf({
        topic: 'Kettles',
        goal: 'Sell more',
        language: 'en',
        audience: undefined,
        guidance: undefined,
        numberOfIdeas: 3,
      }),
    ]);

    expect(omitted).toBe(explicit);
  });

  it('changes when any material field changes', async () => {
    const base = await digestOf(REQUEST);

    for (const changed of [
      { ...REQUEST, topic: 'Something else' },
      { ...REQUEST, goal: 'A different goal' },
      { ...REQUEST, language: 'ar' as const },
      { ...REQUEST, audience: 'Somebody else' },
      { ...REQUEST, guidance: 'Different guidance' },
      { ...REQUEST, numberOfIdeas: 4 },
    ]) {
      await expect(digestOf(changed)).resolves.not.toBe(base);
    }
  });

  /** Opaque, and the same length whatever it was computed over. */
  it('is a fixed-width hex digest that reveals no request text', async () => {
    const digest = await digestOf(REQUEST);

    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    for (const secret of SECRETS) {
      expect(digest).not.toContain(secret);
      expect(digest.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });
});

describe('what is written to the browser', () => {
  it('stores the key and the digest, and nothing else', async () => {
    const pending = await keyForSubmission('org_1', REQUEST, mint);

    writePendingSubmission('org_1', pending);

    const stored: unknown = JSON.parse(
      window.sessionStorage.getItem(STORAGE_KEY) ?? 'null',
    );

    expect(stored).toEqual({
      idempotencyKey: 'key_1',
      requestDigest: await digestOf(REQUEST),
    });
    expect(Object.keys(stored as object).sort()).toEqual([
      'idempotencyKey',
      'requestDigest',
    ]);
  });

  /**
   * The regression this file exists for.
   *
   * The previous record was `JSON.stringify` of the request, so every one of
   * these strings was sitting in `sessionStorage` for any script on the origin
   * to read. Asserting against the whole dump rather than against one key means
   * a future record that stashes the request under a *different* key fails too.
   */
  it('leaves no request text anywhere in session storage', async () => {
    const pending = await keyForSubmission('org_1', REQUEST, mint);

    writePendingSubmission('org_1', pending);

    const dump = storageDump();

    expect(dump).not.toBe('');

    for (const secret of SECRETS) {
      expect(dump).not.toContain(secret);
    }
  });

  /**
   * Written field by field, so a caller that hands this a record carrying the
   * request alongside the key cannot put the request in the browser by
   * accident — which is precisely how the plaintext got there before.
   */
  it('ignores extra fields a caller attaches to the record', async () => {
    writePendingSubmission('org_1', {
      idempotencyKey: 'key_x',
      requestDigest: 'a'.repeat(64),
      request: REQUEST,
    } as never);

    expect(storageDump()).not.toContain('Nightjar');
    expect(
      JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? 'null'),
    ).toEqual({ idempotencyKey: 'key_x', requestDigest: 'a'.repeat(64) });
  });

  it('is forgotten when the submission is no longer ambiguous', async () => {
    writePendingSubmission('org_1', await keyForSubmission('org_1', REQUEST, mint));

    clearPendingSubmission('org_1');

    expect(readPendingSubmission('org_1')).toBeNull();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe('keyForSubmission', () => {
  it('reuses the stored key for the same material request', async () => {
    const first = await keyForSubmission('org_1', REQUEST, mint);
    writePendingSubmission('org_1', first);

    const second = await keyForSubmission('org_1', REQUEST, mint);

    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(minted).toBe(1);
  });

  it('mints a new key for a materially different request', async () => {
    const first = await keyForSubmission('org_1', REQUEST, mint);
    writePendingSubmission('org_1', first);

    const second = await keyForSubmission(
      'org_1',
      { ...REQUEST, topic: 'A different topic entirely' },
      mint,
    );

    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  /** One tab's pending purchase is not another organization's. */
  it('does not reuse another organization’s key', async () => {
    writePendingSubmission(
      'org_1',
      await keyForSubmission('org_1', REQUEST, mint),
    );

    const other = await keyForSubmission('org_2', REQUEST, mint);

    expect(other.idempotencyKey).toBe('key_2');
  });

  /**
   * The precedence rule, with both records present — which is the only
   * arrangement that can prove it.
   *
   * The stored record is the one that survived a reload, so it is the
   * authoritative of the two. With only one present at a time the loop can be
   * written in either order and nothing notices, which is exactly how a
   * documented rule becomes a comment about code that does something else.
   */
  it('prefers the stored record over the in-memory one', async () => {
    const requestDigest = await digestOf(REQUEST);

    writePendingSubmission('org_1', {
      idempotencyKey: 'key_from_storage',
      requestDigest,
    });

    const reused = await keyForSubmission('org_1', REQUEST, mint, {
      idempotencyKey: 'key_from_memory',
      requestDigest,
    });

    expect(reused.idempotencyKey).toBe('key_from_storage');
    expect(minted).toBe(0);
  });

  /**
   * The in-memory fallback is checked *after* the stored record, because the
   * stored one is what survived the reload and is therefore the authoritative
   * of the two.
   */
  it('falls back to the in-memory record when nothing was stored', async () => {
    const inMemory = {
      idempotencyKey: 'key_from_memory',
      requestDigest: await digestOf(REQUEST),
    };

    const reused = await keyForSubmission('org_1', REQUEST, mint, inMemory);

    expect(reused.idempotencyKey).toBe('key_from_memory');
    expect(minted).toBe(0);
  });

  it('does not reuse an in-memory record for a different request', async () => {
    const inMemory = {
      idempotencyKey: 'key_from_memory',
      requestDigest: await digestOf(REQUEST),
    };

    const minted2 = await keyForSubmission(
      'org_1',
      { ...REQUEST, goal: 'Something entirely different' },
      mint,
      inMemory,
    );

    expect(minted2.idempotencyKey).toBe('key_1');
  });

  /**
   * A record written by a build that stored the request verbatim is discarded
   * rather than adapted. Minting a fresh key for a submission this tab has no
   * reliable record of is the safe direction; the alternative is reusing a key
   * against a request nobody can confirm it was bound to.
   */
  it('discards a record that is not the current shape', async () => {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ key: 'legacy_key', fingerprint: JSON.stringify(REQUEST) }),
    );

    expect(readPendingSubmission('org_1')).toBeNull();
    await expect(
      keyForSubmission('org_1', REQUEST, mint),
    ).resolves.toEqual({
      idempotencyKey: 'key_1',
      requestDigest: await digestOf(REQUEST),
    });
  });

  it('survives a corrupt record', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, 'not json at all');

    expect(readPendingSubmission('org_1')).toBeNull();
    await expect(
      keyForSubmission('org_1', REQUEST, mint),
    ).resolves.toMatchObject({ idempotencyKey: 'key_1' });
  });

  /**
   * A digest that cannot be computed is a failed submission, not a silent
   * fallback to storing the request.
   *
   * `crypto.subtle` is absent outside a secure context, exactly like
   * `crypto.randomUUID` — so this rejects rather than degrading, and the caller
   * is responsible for showing it. The alternative that must never appear is a
   * fallback that persists the plaintext when the digest is unavailable.
   */
  it('rejects rather than degrading when the digest cannot be computed', async () => {
    const digest = vi
      .spyOn(crypto.subtle, 'digest')
      .mockRejectedValue(new Error('SubtleCrypto is unavailable'));

    try {
      await expect(keyForSubmission('org_1', REQUEST, mint)).rejects.toThrow(
        'SubtleCrypto is unavailable',
      );

      expect(storageDump()).toBe('');
      expect(minted).toBe(0);
    } finally {
      digest.mockRestore();
    }
  });

  /** A browser configured to block site data must still be able to submit. */
  it('still produces a key when storage refuses to answer', async () => {
    const getItem = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('storage is blocked');
      });
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('storage is blocked');
      });

    try {
      const pending = await keyForSubmission('org_1', REQUEST, mint);

      expect(pending.idempotencyKey).toBe('key_1');
      expect(() => writePendingSubmission('org_1', pending)).not.toThrow();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});
