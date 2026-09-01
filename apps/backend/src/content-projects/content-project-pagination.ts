import { AppException } from '../core/errors';

/**
 * Keyset pagination for the content-project listing.
 *
 * A separate module from the service for one reason: everything here is a pure
 * function with more refusal branches than the HTTP surface can reach. The
 * cursor decoder alone has six ways to say no, and an end-to-end test can only
 * ever exercise the first — so left inside the service they would be code that
 * exists, is never run by a test, and drifts. `knowledge-pagination.ts` splits
 * for exactly this reason and is worth matching.
 *
 * The position is `(createdAt, id)`, matching the listing's order. `createdAt`
 * alone is not unique — two projects promoted in the same millisecond are
 * ordinary — so the id breaks the tie and is unique by construction. Drop the
 * tiebreak and every row sharing a boundary timestamp is silently skipped.
 *
 * ## What a cursor is not
 *
 * It is not a capability. It carries no organization and no authority: the
 * query it is spliced into keeps its own `organizationId` predicate, so a
 * cursor minted in another organization positions over nothing but the
 * caller's own rows. That is what makes base64 acceptable here where signing
 * would otherwise be required.
 */
export type ProjectCursor = { createdAt: Date; id: string };

/** The default page, and the ceiling a caller cannot raise. */
export const CONTENT_PROJECT_PAGE_SIZE = 25;
export const MAX_CONTENT_PROJECT_PAGE_SIZE = 100;

/**
 * The sole owner of the page ceiling.
 *
 * The controller validates the *shape* of `limit` and deliberately not its
 * range, so this branch is reachable over HTTP rather than being a second copy
 * of the rule that nothing can test.
 */
export function pageSize(requested: number | undefined): number {
  if (requested === undefined) return CONTENT_PROJECT_PAGE_SIZE;

  if (
    !Number.isInteger(requested) ||
    requested < 1 ||
    requested > MAX_CONTENT_PROJECT_PAGE_SIZE
  ) {
    throw new AppException('VALIDATION_ERROR', {
      context: { resource: 'contentProject', reason: 'limit' },
      publicDetails: {
        reason: `A page holds between 1 and ${MAX_CONTENT_PROJECT_PAGE_SIZE} projects.`,
      },
    });
  }

  return requested;
}

export function beforePosition(after: ProjectCursor) {
  return {
    OR: [
      { createdAt: { lt: after.createdAt } },
      { createdAt: after.createdAt, id: { lt: after.id } },
    ],
  };
}

export function encodeCursor(cursor: ProjectCursor): string {
  return Buffer.from(
    JSON.stringify({ at: cursor.createdAt.toISOString(), id: cursor.id }),
    'utf8',
  ).toString('base64url');
}

export function decodeCursor(value: string): ProjectCursor {
  const invalid = () =>
    new AppException('VALIDATION_ERROR', {
      context: { resource: 'contentProject', reason: 'cursor' },
      publicDetails: { reason: 'The page cursor is not readable.' },
    });

  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }

  if (typeof parsed !== 'object' || parsed === null) throw invalid();

  const { at, id } = parsed as Record<string, unknown>;

  if (
    typeof at !== 'string' ||
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > 120
  ) {
    throw invalid();
  }

  const createdAt = new Date(at);
  if (Number.isNaN(createdAt.getTime())) throw invalid();

  return { createdAt, id };
}
