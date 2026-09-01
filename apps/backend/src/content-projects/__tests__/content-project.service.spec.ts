import { describe, expect, it } from '@jest/globals';

import { DEFAULT_LOCALE } from '@repo/i18n-core';

import type { AgentRun } from '../../agents';
import { contentLanguage, projectKey } from '../content-project.service';

/**
 * The branches an end-to-end test reaches only by accident.
 *
 * Both of these read a JSON column whose contents the compiler cannot vouch
 * for, so their fallbacks are the parts most likely to be quietly changed and
 * least likely to be noticed.
 */

const run = (input: unknown): AgentRun =>
  ({
    id: 'run_1',
    agentId: 'content-idea',
    agentVersion: 1,
    status: 'SUCCEEDED',
    organizationId: 'org_1',
    input,
    output: null,
  }) as unknown as AgentRun;

const VALID_INPUT = {
  topic: 'Electric kettles',
  goal: 'Sell the autumn range',
  language: 'en',
  numberOfIdeas: 3,
};

describe('contentLanguage', () => {
  it('takes the language the request named', () => {
    expect(contentLanguage(run(VALID_INPUT))).toBe('en');
    expect(contentLanguage(run({ ...VALID_INPUT, language: 'ar' }))).toBe('ar');
  });

  /**
   * A run whose stored input no longer parses is still selectable.
   *
   * Throwing here would make a historical run permanently unusable over a field
   * that is not load-bearing — the idea itself is unaffected, and the draft's
   * language can be corrected.
   */
  it.each([
    ['an input that lost a required field', { topic: 'Kettles' }],
    ['an unknown language', { ...VALID_INPUT, language: 'fr' }],
    ['a non-object input', 'nonsense'],
    ['null', null],
  ])('falls back to the product default for %s', (_label, input) => {
    expect(contentLanguage(run(input))).toBe(DEFAULT_LOCALE);
  });

  it('uses the product default rather than a hard-coded literal', () => {
    // If DEFAULT_LOCALE moves, this fallback moves with it.
    expect(contentLanguage(run(null))).toBe(DEFAULT_LOCALE);
  });
});

describe('projectKey', () => {
  it('is stable for the same caller key and selection', () => {
    const selection = { sourceRunId: 'run_1', ideaIndex: 0 };

    expect(projectKey('abc12345', selection)).toBe(
      projectKey('abc12345', selection),
    );
  });

  /**
   * The property the durable constraint depends on: reuse of one key with a
   * different selection must not collide with the first request's key.
   */
  it.each([
    ['a different index', { sourceRunId: 'run_1', ideaIndex: 1 }],
    ['a different run', { sourceRunId: 'run_2', ideaIndex: 0 }],
  ])('differs for %s', (_label, selection) => {
    expect(projectKey('abc12345', selection)).not.toBe(
      projectKey('abc12345', { sourceRunId: 'run_1', ideaIndex: 0 }),
    );
  });

  it('differs for a different caller key', () => {
    const selection = { sourceRunId: 'run_1', ideaIndex: 0 };

    expect(projectKey('abc12345', selection)).not.toBe(
      projectKey('zzz99999', selection),
    );
  });

  /**
   * The digest is fixed-length and terminal, so the composed key cannot be
   * ambiguous: a caller key containing a colon cannot shift the boundary and
   * make two different requests compose to one string.
   */
  it('cannot be made ambiguous by a colon in the caller key', () => {
    expect(projectKey('a:b', { sourceRunId: 'run_1', ideaIndex: 0 })).not.toBe(
      projectKey('a', { sourceRunId: 'run_1', ideaIndex: 0 }),
    );
  });
});
