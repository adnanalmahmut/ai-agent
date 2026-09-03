import { describe, expect, it } from '@jest/globals';

import { digestStrings, digestValue } from '../../../../src/ai/tools/digest';

describe('digestValue', () => {
  it('is stable across key order', () => {
    expect(digestValue({ a: 1, b: { c: [1, 2], d: 'x' } })).toBe(
      digestValue({ b: { d: 'x', c: [1, 2] }, a: 1 }),
    );
  });

  it('distinguishes values that differ in any field', () => {
    const base = { recipientMemberId: 'm1', subject: 's', body: 'b' };

    expect(digestValue(base)).not.toBe(digestValue({ ...base, body: 'b2' }));
    expect(digestValue(base)).not.toBe(
      digestValue({ ...base, recipientMemberId: 'm2' }),
    );
  });

  it('does not treat array order as irrelevant', () => {
    // Arrays are ordered data; a digest that sorted them would call two
    // different payloads the same.
    expect(digestValue([1, 2])).not.toBe(digestValue([2, 1]));
  });

  it('is sixty-four hex characters', () => {
    expect(digestValue({ x: null })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('digests a string list as the list, not as a concatenation', () => {
    // `["ab","c"]` and `["a","bc"]` concatenate identically; the payload
    // digest must not.
    expect(digestStrings(['ab', 'c'])).not.toBe(digestStrings(['a', 'bc']));
  });
});
