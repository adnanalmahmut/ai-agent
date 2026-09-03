import { describe, expect, it } from '@jest/globals';

import { projectKey } from '../../../../../src/features/content/projects/content-project.service';

describe('projectKey', () => {
  it('is stable for the same caller key and selection', () => {
    const selection = { sourceRunId: 'run_1', ideaIndex: 0 };

    expect(projectKey('abc12345', selection)).toBe(
      projectKey('abc12345', selection),
    );
  });

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

  it('cannot be made ambiguous by a colon in the caller key', () => {
    expect(projectKey('a:b', { sourceRunId: 'run_1', ideaIndex: 0 })).not.toBe(
      projectKey('a', { sourceRunId: 'run_1', ideaIndex: 0 }),
    );
  });
});
