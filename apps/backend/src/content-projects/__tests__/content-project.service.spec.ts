import { describe, expect, it } from '@jest/globals';

import { projectKey } from '../content-project.service';

/**
 * The key composition, which the durable constraint depends on.
 *
 * The language fallback that used to be tested here is gone: the brief and the
 * content language now come from one parse of the run's input, and a run whose
 * input cannot be read is refused rather than defaulted. That refusal is a
 * database-coupled path and is covered end to end.
 */

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
