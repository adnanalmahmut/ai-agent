import {
  ApiError,
  ApiUnavailableError,
  NO_ERROR_DETAILS,
} from '@/lib/application-api';
import type { ApiErrorDetails } from '@/lib/application-api';

export const CONTENT_IDEA_FAILURES = [
  'unavailable',
  'unauthenticated',
  'forbidden',
  'disabled',
  'invalid',
  'busy',
  'gone',
  'failed',
] as const;

export type ContentIdeaFailureKind = (typeof CONTENT_IDEA_FAILURES)[number];

export type ContentIdeaFailure = {
  kind: ContentIdeaFailureKind;
  details: ApiErrorDetails;
};

export function classifyContentIdeaFailure(
  thrown: unknown,
): ContentIdeaFailure {
  const details =
    thrown instanceof ApiError ? thrown.details : NO_ERROR_DETAILS;

  if (thrown instanceof ApiUnavailableError) {
    return { kind: 'unavailable', details };
  }

  if (thrown instanceof ApiError) {
    if (thrown.status === 401) return { kind: 'unauthenticated', details };
    if (thrown.status === 403) {
      return {
        kind: thrown.code === 'FEATURE_DISABLED' ? 'disabled' : 'forbidden',
        details,
      };
    }
    if (thrown.status === 429) return { kind: 'busy', details };
    if (thrown.status === 404) return { kind: 'gone', details };
    if (thrown.status === 400) return { kind: 'invalid', details };
  }

  return { kind: 'failed', details };
}

export function isUnreadable(thrown: unknown): boolean {
  return thrown instanceof ApiError && [401, 403, 404].includes(thrown.status);
}

export function isDecided(thrown: unknown): boolean {
  return (
    thrown instanceof ApiError && thrown.status < 500 && thrown.status !== 408
  );
}
