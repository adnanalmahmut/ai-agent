import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearPendingSubmission,
  digestOf,
  keyForSubmission,
  readPendingSubmission,
  writePendingSubmission,
} from './content-idea-submission';
import type { ContentIdeaRequest } from './organization-api';

const STORAGE_KEY = 'content-idea:pending:org_1';

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

  it('leaves no request text anywhere in session storage', async () => {
    const pending = await keyForSubmission('org_1', REQUEST, mint);

    writePendingSubmission('org_1', pending);

    const dump = storageDump();

    expect(dump).not.toBe('');

    for (const secret of SECRETS) {
      expect(dump).not.toContain(secret);
    }
  });

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
    writePendingSubmission(
      'org_1',
      await keyForSubmission('org_1', REQUEST, mint),
    );

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

  it('does not reuse another organization’s key', async () => {
    writePendingSubmission(
      'org_1',
      await keyForSubmission('org_1', REQUEST, mint),
    );

    const other = await keyForSubmission('org_2', REQUEST, mint);

    expect(other.idempotencyKey).toBe('key_2');
  });

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

  it('discards a record that is not the current shape', async () => {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        key: 'legacy_key',
        fingerprint: JSON.stringify(REQUEST),
      }),
    );

    expect(readPendingSubmission('org_1')).toBeNull();
    await expect(keyForSubmission('org_1', REQUEST, mint)).resolves.toEqual({
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
