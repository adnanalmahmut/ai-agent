import { describe, expect, it } from 'vitest';

import { userInitials } from './user-initials';

describe('userInitials', () => {
  it('takes the first letter of the first two words', () => {
    expect(userInitials('Sara Haddad', 'sara@example.com')).toBe('SH');
  });

  it('ignores anything past the second word', () => {
    expect(userInitials('Ada King Lovelace', 'ada@example.com')).toBe('AK');
  });

  it('handles a single name', () => {
    expect(userInitials('Sara', 'sara@example.com')).toBe('S');
  });

  it('works in Arabic', () => {
    expect(userInitials('سارة حداد', 'sara@example.com')).toBe('سح');
  });

  it('falls back to the local part of the email', () => {
    // Never to a hard-coded letter, which would make every unnamed user look
    // like the same person.
    expect(userInitials(null, 'ada.lovelace@example.com')).toBe('A');
    expect(userInitials('   ', 'ada@example.com')).toBe('A');
  });

  it('does not slice a grapheme in half', () => {
    // A single code unit of an emoji or a combining sequence renders as a
    // replacement character.
    expect(userInitials('🌍 Team', 'team@example.com')).toBe('🌍T');
  });

  it('survives an empty email', () => {
    expect(userInitials(null, '')).toBe('');
  });
});
