import { describe, expect, it } from 'vitest';

import { ApiError, ApiUnavailableError } from '@/lib/application-api';

import {
  CONTENT_IDEA_FAILURES,
  classifyContentIdeaFailure as classify,
  isDecided,
} from './content-idea-failures';

/**
 * The whole mapping, in one place.
 *
 * The screen's own tests drive the branches an operator can actually produce
 * by clicking; these cover the mapping itself, including the two nobody can
 * reach from a test that goes through the form — an expired session and a
 * server that failed rather than refused.
 */
describe('classifying a content-idea refusal', () => {
  it.each([
    ['a request that never arrived', new ApiUnavailableError(), 'unavailable'],
    ['an expired session', new ApiError(401, 'UNAUTHORIZED'), 'unauthenticated'],
    // Both 403. Telling an owner who holds every grant that they lack
    // permission sends them to change roles over something no role can fix.
    ['a switched-off feature', new ApiError(403, 'FEATURE_DISABLED'), 'disabled'],
    ['a permission not held', new ApiError(403, 'FORBIDDEN'), 'forbidden'],
    ['a refused body', new ApiError(400, 'VALIDATION_ERROR'), 'invalid'],
    ['too many requests', new ApiError(429, 'TOO_MANY_REQUESTS'), 'busy'],
    ['an operation nobody can see', new ApiError(404, 'NOT_FOUND'), 'gone'],
    ['a server that broke', new ApiError(500, undefined), 'failed'],
    ['a gateway that gave up', new ApiError(504, undefined), 'failed'],
    ['something that is not an ApiError at all', new TypeError('x'), 'failed'],
  ])('reads %s as %s', (_name, thrown, expected) => {
    expect(classify(thrown).kind).toBe(expected);
  });

  it('carries the reasons the server chose to send', () => {
    const failure = classify(
      new ApiError(400, 'VALIDATION_ERROR', { issues: ['Too big'] }),
    );

    expect(failure.details.issues).toEqual(['Too big']);
  });

  it('never invents details for a failure that carried none', () => {
    expect(classify(new TypeError('x')).details).toEqual({});
  });

  /** Nothing unreachable, and nothing reachable that is missing. */
  it('produces only kinds the copy covers', () => {
    const produced = new Set(
      [
        new ApiUnavailableError(),
        new ApiError(401, 'UNAUTHORIZED'),
        new ApiError(403, 'FEATURE_DISABLED'),
        new ApiError(403, 'FORBIDDEN'),
        new ApiError(400, 'VALIDATION_ERROR'),
        new ApiError(429, 'TOO_MANY_REQUESTS'),
        new ApiError(404, 'NOT_FOUND'),
        new ApiError(500, undefined),
      ].map((thrown) => classify(thrown).kind),
    );

    expect([...produced].sort()).toEqual([...CONTENT_IDEA_FAILURES].sort());
  });
});

/**
 * Whether a retry may keep its idempotency key.
 *
 * Generation is billed. A key kept when the server had already refused asks
 * for a run that was never created; a key discarded when acceptance is unknown
 * buys the same ideas twice. The 5xx row is the one that matters: acceptance
 * commits the run and its outbox event in one transaction, so a proxy timing
 * out after that commit reports failure for work that will be paid for.
 */
describe('whether the server decided', () => {
  it.each([
    ['a validation refusal', new ApiError(400, 'VALIDATION_ERROR'), true],
    ['an expired session', new ApiError(401, 'UNAUTHORIZED'), true],
    ['a switched-off feature', new ApiError(403, 'FEATURE_DISABLED'), true],
    ['a rate limit', new ApiError(429, 'TOO_MANY_REQUESTS'), true],
    ['a request timeout', new ApiError(408, undefined), false],
    ['a broken server', new ApiError(500, undefined), false],
    ['a bad gateway', new ApiError(502, undefined), false],
    ['a gateway timeout', new ApiError(504, undefined), false],
    ['a request that never arrived', new ApiUnavailableError(), false],
  ])('%s: %s', (_name, thrown, expected) => {
    expect(isDecided(thrown)).toBe(expected);
  });
});
