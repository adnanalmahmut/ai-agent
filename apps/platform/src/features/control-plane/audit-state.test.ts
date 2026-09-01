import { describe, expect, it } from 'vitest';

import { displayableKeyVersion, recordsKeyVersion } from './audit-state';

/**
 * The audit table's one exception to rendering only client-owned terms.
 *
 * These tests exist because the gate is a security boundary that looks like a
 * formatting helper. Without them the cap and the character class are two
 * constants nobody would hesitate to relax, and the docblock's careful
 * distinction between bounding a value's shape and vouching for its meaning
 * would be prose with nothing holding it up.
 */
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

  /**
   * Each rejection is a different attack or accident, which is why they are
   * listed rather than sampled.
   *
   * Markup and quotes would be escaped by React regardless; the reason to
   * exclude them here is that this cell should not be a place arbitrary text is
   * displayed at all. The bidirectional-format characters are the ones that need
   * no injection to do damage: they reorder the rendered line, so a value
   * carrying them can make the surrounding row read as something it is not.
   */
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

  /**
   * The boundary, stated as a test so nobody has to take the docblock's word for
   * it — and so nobody can later cite this gate as the reason a credential
   * cannot reach the audit table.
   *
   * A token that is lowercase, hyphenated and inside the cap is admitted no
   * matter what it means. This one is exactly 24 characters and shaped like a
   * live API key, and it passes. That is the honest limit of a shape check.
   *
   * What actually keeps credential material out of this column is upstream and
   * unrelated to this function: the rotation service records a key version only
   * after `ManagedSecretKeyring.open` has succeeded, and resolution requires the
   * version to be one the process was configured with. If that ever changes, this
   * gate will not save the panel, and the fix belongs there rather than here.
   */
  it('admits a credential-shaped token, because it checks shape and not meaning', () => {
    const shapedLikeASecret = 'sk_live_51h8xyzabcdefghi';

    expect(shapedLikeASecret).toHaveLength(24);
    expect(displayableKeyVersion(shapedLikeASecret)).toBe(shapedLikeASecret);
  });

  /** The cap is what stops the longer ones, and it is load-bearing on its own. */
  it('refuses a credential-shaped token that is merely longer', () => {
    expect(
      displayableKeyVersion('sk-live-auditcanary-9f3c2a71b4e8-do-not-render'),
    ).toBeNull();
  });
});

describe('recordsKeyVersion', () => {
  /**
   * The distinction the panel needs: an action that says nothing about the seal
   * versus a version that was recorded and then refused. Both render without a
   * version, and showing them identically would hide the refusal.
   */
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
