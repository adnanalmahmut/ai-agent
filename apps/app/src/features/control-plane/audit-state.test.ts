import { describe, expect, it } from 'vitest';

import { displayableKeyVersion, recordsKeyVersion } from './audit-state';

describe('displayableKeyVersion', () => {
  it.each([
    ['a single character', 'v'],
    ['the ordinary case', 'v2'],
    ['a dated rollout label', '2026.08.31'],
    ['hyphens inside', 'keyver-alpha'],
    ['underscores inside', 'key_ver_2'],
    ['digits only', '20260831'],
    ['exactly the length cap', 'a'.repeat(24)],
  ])('admits %s', (_label, value) => {
    expect(displayableKeyVersion(value)).toBe(value);
  });

  it.each([
    ['one character over the cap', 'a'.repeat(25)],
    ['an uppercase letter', 'V2'],
    ['mixed case', 'keyVer2'],
    ['an inner space', 'key ver'],
    ['a leading space', ' v2'],
    ['a trailing newline', 'v2\n'],
    ['a tab', 'v2\t'],
    ['leading punctuation', '-v2'],
    ['trailing punctuation', 'v2-'],
    ['a trailing dot', 'v2.'],
    ['markup', '<img src=x onerror=alert(1)>'],
    ['a double quote', 'v2"'],
    ['a brace', 'v2{}'],
    ['an ICU placeholder', '{keyVersion}'],
    ['a right-to-left override', 'v2‮'],
    ['a left-to-right isolate', '⁦v2'],
    ['a zero-width joiner', 'v‍2'],
    ['a non-ASCII letter', 'مفتاح'],
    ['an emoji', 'v2\u{1f512}'],
    ['the empty string', ''],
  ])('refuses %s', (_label, value) => {
    expect(displayableKeyVersion(value)).toBeNull();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 2],
    ['an object', { keyVersion: 'v2' }],
    ['an array', ['v2']],
    ['a boolean', true],
  ])('refuses %s, which is not a string at all', (_label, value) => {
    expect(displayableKeyVersion(value)).toBeNull();
  });

  it('admits a credential-shaped token, because it checks shape and not meaning', () => {
    const shapedLikeASecret = 'sk_live_51h8xyzabcdefghi';

    expect(shapedLikeASecret).toHaveLength(24);
    expect(displayableKeyVersion(shapedLikeASecret)).toBe(shapedLikeASecret);
  });

  it('refuses a credential-shaped token that is merely longer', () => {
    expect(
      displayableKeyVersion('sk-live-auditcanary-9f3c2a71b4e8-do-not-render'),
    ).toBeNull();
  });
});

describe('recordsKeyVersion', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('reports %s as recording no version', (_label, value) => {
    expect(recordsKeyVersion(value)).toBe(false);
  });

  it.each([
    ['a displayable version', 'v2'],
    ['a version the gate refuses', 'V2'],
    ['a value that is not a string', 42],
  ])('reports %s as recording one', (_label, value) => {
    expect(recordsKeyVersion(value)).toBe(true);
  });
});
