import { AppException } from '../../../core/errors';

export type ProjectCursor = { createdAt: Date; id: string };

export const CONTENT_PROJECT_PAGE_SIZE = 25;
export const MAX_CONTENT_PROJECT_PAGE_SIZE = 100;

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
