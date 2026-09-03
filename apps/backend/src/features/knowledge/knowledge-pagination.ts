import { AppException } from '../../core/errors';

export type DocumentCursor = { title: string; id: string };

export const DOCUMENT_PAGE_SIZE = 50;
export const MAX_DOCUMENT_PAGE_SIZE = 100;

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
