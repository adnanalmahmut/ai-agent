import { Prisma } from '../../generated/prisma/client';

/**
 * What the database driver is saying, and nothing about what it means.
 *
 * Four services had written the same `instanceof` plus code comparison, which
 * is four places to get the code wrong and four places to update when the
 * client changes shape. The comparison lives here now.
 *
 * Deliberately no further than that: a predicate here says a unique constraint
 * was violated, not that the answer is 409, not which business code it maps
 * to, and not which field the caller should fix. Only the use case knows
 * whether a duplicate is `EMAIL_ALREADY_EXISTS`, `already_installed`, or an
 * idempotent retry that should return the row it collided with -- so the
 * mapping stays with the use case, and this module knows only Prisma.
 */

function isPrismaKnownRequestError(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError;
}

/**
 * P2002: a write collided with a unique index.
 *
 * The narrowed type is part of the contract — a caller that needs to know
 * which index collided reads `error.meta` without asserting its way there.
 */
export function isUniqueConstraintViolation(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return isPrismaKnownRequestError(error) && error.code === 'P2002';
}
