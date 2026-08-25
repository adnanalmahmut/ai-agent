import { ApiError, ApiUnavailableError } from '@/lib/application-api';
import type { ApiErrorDetails } from '@/lib/application-api';

/**
 * Interpretation of a content-idea refusal, kept away from the component that
 * renders it.
 *
 * Same shape as `invitation-state.ts` and `organization-errors.ts`, and here
 * for the same two reasons: the set of states the UI can render is worth
 * reading in one place, and it has to be a runtime value so the message test
 * can assert every one of them has copy in both dictionaries. A branch added
 * without its two entries would otherwise ship a raw key path —
 * `error.throttled` — to a reader.
 *
 * These are the states the *backend* can actually be told apart into. Nothing
 * is invented for symmetry: there is no `conflict`, because neither route
 * produces a 409 — the in-flight ceiling answers 429, and a replayed
 * idempotency key returns the run it already made.
 */
export const CONTENT_IDEA_FAILURES = [
  /** The request never reached the server. */
  'unavailable',
  'unauthenticated',
  /** A permission this member does not hold. */
  'forbidden',
  /** The capability is switched off, which no role can fix. */
  'disabled',
  /** The request was refused by the schema. */
  'invalid',
  /** This member going too fast, or the organization at its in-flight ceiling. */
  'busy',
  /** No such operation, for this organization, from this agent. */
  'gone',
  /** Anything else, including a server that failed rather than refused. */
  'failed',
] as const;

export type ContentIdeaFailureKind = (typeof CONTENT_IDEA_FAILURES)[number];

export type ContentIdeaFailure = {
  kind: ContentIdeaFailureKind;
  details: ApiErrorDetails;
};

/**
 * Which refusal this was, from the code rather than the status alone.
 *
 * A disabled feature and a missing permission are both 403, and telling an
 * owner who holds every grant that they lack permission sends them to change
 * roles over something no role can fix — so the code decides.
 *
 * A 429 is either this member going too fast or the organization already
 * holding as many runs as the operator allows. Only the second carries a
 * `reason`; the rate limiter sends `retryAfterSec`, which this application does
 * not surface. So the shared message has to stand on its own for the common
 * case, and a reason is additional detail when there is one rather than the
 * thing that tells the two apart.
 */
export function classifyContentIdeaFailure(thrown: unknown): ContentIdeaFailure {
  const details = thrown instanceof ApiError ? thrown.details : {};

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

/**
 * Whether a failed *poll* means this operation will never be readable.
 *
 * Different question from `isDecided`, and the difference is what keeps a
 * billed run being watched. A 401, a revoked permission or a 404 are the
 * server answering about this operation, and asking again cannot change the
 * answer. A 5xx is an instance being rolled. A 429 is this tab's own polling
 * having spent the route's budget — which is the one case where stopping is
 * actively harmful: it strands a run that is still executing and shows copy
 * inviting the resubmission that bills a second one.
 *
 * Everything else is ridden out. The give-up timeout is the backstop, and
 * reporting a run as still running is both true and cheaper than a wrong
 * refusal.
 */
export function isUnreadable(thrown: unknown): boolean {
  return (
    thrown instanceof ApiError && [401, 403, 404].includes(thrown.status)
  );
}

/**
 * Whether the server has answered about a submission, one way or the other.
 *
 * A refusal the server *chose* — a validation error, a disabled feature, a
 * permission — means no run was created, so the next attempt is a new request
 * with a new key. A 5xx or a gateway timeout means no such thing: acceptance
 * commits the run and its outbox event in one transaction, so a proxy timing
 * out or an instance being rolled after that commit returns a failure for work
 * that was accepted and will be billed. Minting a fresh key there buys the same
 * ideas twice; keeping it is safe either way, because the durable key finds the
 * run if there is one and creates it once if there is not.
 */
export function isDecided(thrown: unknown): boolean {
  return (
    thrown instanceof ApiError && thrown.status < 500 && thrown.status !== 408
  );
}
