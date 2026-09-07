import { describe, expect, it } from 'vitest';

import {
  ApiError,
  ApiUnavailableError,
  errorDetailLines,
} from '@/lib/application-api';

import {
  CONTENT_IDEA_FAILURES,
  classifyContentIdeaFailure as classify,
  isDecided,
} from './content-idea-failures';

describe('classifying a content-idea refusal', () => {
  it.each([
    ['a request that never arrived', new ApiUnavailableError(), 'unavailable'],
    [
      'an expired session',
      new ApiError(401, 'UNAUTHORIZED'),
      'unauthenticated',
    ],
    [
      'a switched-off feature',
      new ApiError(403, 'FEATURE_DISABLED'),
      'disabled',
    ],
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
      new ApiError(400, 'VALIDATION_ERROR', {
        kind: 'validation',
        fields: [],
        messages: ['Too big'],
      }),
    );

    expect(errorDetailLines(failure.details)).toEqual(['Too big']);
  });

  it('never invents details for a failure that carried none', () => {
    expect(classify(new TypeError('x')).details).toEqual({ kind: 'none' });
  });

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
