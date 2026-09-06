import { describe, expect, it } from '@jest/globals';

import { Prisma } from '../../../../src/generated/prisma/client';
import { isUniqueConstraintViolation } from '../../../../src/infrastructure/database/prisma-errors';

const knownRequestError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('driver said no', {
    code,
    clientVersion: 'test',
  });

describe('the unique-constraint predicate', () => {
  it('recognises the collision it is named after', () => {
    expect(isUniqueConstraintViolation(knownRequestError('P2002'))).toBe(true);
  });

  it('narrows the type so a caller can read which index collided', () => {
    const error: unknown = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['email'] },
    });

    if (!isUniqueConstraintViolation(error)) throw new Error('not narrowed');

    expect(error.meta).toEqual({ target: ['email'] });
  });

  it.each(['P2003', 'P2025', 'P2010', 'P1001'])(
    'says nothing about %s',
    (code) => {
      // Narrow on purpose. Nothing in this codebase maps these yet, and a
      // predicate that answered for them would invite a caller to treat a
      // missing row or a dead connection as a duplicate.
      expect(isUniqueConstraintViolation(knownRequestError(code))).toBe(false);
    },
  );

  it('is not fooled by something merely shaped like a driver error', () => {
    expect(isUniqueConstraintViolation({ code: 'P2002' })).toBe(false);
    expect(isUniqueConstraintViolation(new Error('P2002'))).toBe(false);
    expect(isUniqueConstraintViolation(undefined)).toBe(false);
    expect(isUniqueConstraintViolation(null)).toBe(false);
  });
});
