import { AppException } from '../../core/errors';

/**
 * Keyset pagination for document listings.
 *
 * Offset paging is wrong for a collection that is written to while it is being
 * read: ingesting a document whose title sorts early shifts every later row
 * back by one, so the reader's next page repeats a row and skips another. The
 * cursor here names a *position* — the last row returned — so the next page
 * starts after it regardless of what was inserted in between.
 *
 * The position is `(title, id)`, matching the listing's order exactly. Title
 * alone is not unique within a space, so two documents sharing one would make
 * the boundary ambiguous and paging would either loop or skip; the id breaks
 * the tie and is unique by construction.
 *
 * ## What a cursor is not
 *
 * It is not a capability. It carries no organization, no space, and no
 * authority — it is an opaque encoding of a sort position, and the query it is
 * spliced into keeps its own `organizationId` and `spaceId` predicates. A
 * cursor minted in another organization therefore reveals nothing and grants
 * nothing: it names a title and a uuid, and the rows it could position over are
 * still only the caller's own. That is the property worth stating, because it
 * is what makes base64 acceptable here where signing would otherwise be
 * required.
 */
export type DocumentCursor = { title: string; id: string };

/** The default page, and the ceiling a caller cannot raise. */
export const DOCUMENT_PAGE_SIZE = 50;
export const MAX_DOCUMENT_PAGE_SIZE = 100;

/**
 * Bounds the page size server-side.
 *
 * A client asking for everything is asking the database to build a response
 * whose size is the size of the space, and "the client requested it" is not a
 * reason to. Out-of-range values are refused rather than clamped: silently
 * returning fifty rows to a caller who asked for five thousand looks like the
 * collection ended.
 */
export function pageSize(requested: number | undefined): number {
  if (requested === undefined) return DOCUMENT_PAGE_SIZE;

  if (
    !Number.isInteger(requested) ||
    requested < 1 ||
    requested > MAX_DOCUMENT_PAGE_SIZE
  ) {
    throw new AppException('VALIDATION_ERROR', {
      context: { resource: 'knowledgeDocument', reason: 'limit' },
      publicDetails: {
        reason: `A page size must be a whole number between 1 and ${MAX_DOCUMENT_PAGE_SIZE}.`,
      },
    });
  }

  return requested;
}

export function encodeCursor(cursor: DocumentCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Parses a cursor, refusing anything that is not one.
 *
 * A malformed cursor is a 400 rather than a silently ignored parameter,
 * because ignoring it restarts the listing from the beginning — which a client
 * paging through a collection reads as "there are more rows" forever.
 */
export function decodeCursor(value: string): DocumentCursor {
  const invalid = () =>
    new AppException('VALIDATION_ERROR', {
      context: { resource: 'knowledgeDocument', reason: 'cursor' },
      publicDetails: { reason: 'The page cursor is not readable.' },
    });

  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }

  if (typeof parsed !== 'object' || parsed === null) throw invalid();

  const { title, id } = parsed as Record<string, unknown>;

  if (typeof title !== 'string' || typeof id !== 'string') throw invalid();

  return { title, id };
}
