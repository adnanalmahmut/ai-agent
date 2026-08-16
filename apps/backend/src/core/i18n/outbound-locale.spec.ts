import { describe, expect, it } from '@jest/globals';

import { resolveOutboundLocale } from './outbound-locale';

describe('resolveOutboundLocale', () => {
  it('prefers an explicitly requested locale', () => {
    expect(
      resolveOutboundLocale({
        requested: 'en',
        userPreferred: 'ar',
        requestLocale: 'ar',
      }),
    ).toBe('en');
  });

  it("falls back to the recipient's stored preference", () => {
    expect(
      resolveOutboundLocale({ userPreferred: 'en', requestLocale: 'ar' }),
    ).toBe('en');
  });

  it('falls back to the locale of the originating request', () => {
    expect(resolveOutboundLocale({ requestLocale: 'en' })).toBe('en');
  });

  it('defaults to Arabic when no candidate is available', () => {
    expect(resolveOutboundLocale({})).toBe('ar');
  });

  it('never yields an unsupported locale', () => {
    expect(
      resolveOutboundLocale({
        requested: 'klingon',
        userPreferred: 'fr',
        requestLocale: 'de',
      }),
    ).toBe('ar');
  });

  it('skips an invalid candidate in favour of a valid lower-priority one', () => {
    expect(
      resolveOutboundLocale({ requested: 'fr', userPreferred: 'en' }),
    ).toBe('en');
  });

  it('ignores non-string candidates', () => {
    expect(
      resolveOutboundLocale({
        requested: null,
        userPreferred: undefined,
        requestLocale: 42,
      }),
    ).toBe('ar');
  });

  it('is deterministic, so a retry resolves the same locale as the first attempt', () => {
    // The point of resolving *before* enqueueing: the job payload is the only
    // input, so re-running a failed job cannot pick up a different language
    // from some other request's context.
    const payloadInputs = { requested: 'en' as const };

    const first = resolveOutboundLocale(payloadInputs);
    const retry = resolveOutboundLocale(payloadInputs);

    expect(retry).toBe(first);
  });
});
