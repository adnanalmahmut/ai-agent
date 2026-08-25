import { Prisma } from '../generated/prisma/client';

/**
 * A unique-constraint violation, recognised by its code.
 *
 * Local to this module rather than shared, because the same three lines exist
 * in `agent-run.service.ts` for a different constraint and a shared helper
 * would invite callers to treat "some uniqueness failed" as one condition. It
 * never is: the caller has to know *which* constraint to answer usefully, and
 * that knowledge is local.
 */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
