import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    EXECUTION_CONTEXT_BUDGET_CODE_POINTS,
    EXECUTION_PAYLOAD_BUDGET_BYTES,
    validateExecutionDocument,
    validateRuntimeStep,
    validateSafeFailure,
} from '../dist/index.js';

const step = {
  version: '1',
  stepId: 'step_1',
  runId: 'run_1',
  organizationId: 'org_1',
  attempt: 1,
  acceptedAt: '2026-09-07T00:00:00.000Z',
  agent: { id: 'content-idea', version: 1 },
  model: {
    policyId: 'content-idea.model-policy.1',
    modelId: 'openai.gpt-4o-mini',
    pricingRevisionId: 'openai.gpt-4o-mini.pricing.1',
  },
  input: { topic: 'spring' },
  context: [],
  grantedTools: [],
};

const withInput = (input) => ({ ...step, input });

describe('values that are not JSON', () => {
  it('accepts the plain document they are variations of', () => {
    assert.equal(validateRuntimeStep(step).ok, true);
  });

  const rejected = [
    ['a Date object', withInput({ at: new Date('2026-09-07T00:00:00Z') })],
    ['a BigInt', withInput({ size: 10n })],
    ['a function', withInput({ run: () => 1 })],
    ['NaN', withInput({ score: Number.NaN })],
    ['Infinity', withInput({ score: Number.POSITIVE_INFINITY })],
    ['-Infinity', withInput({ score: Number.NEGATIVE_INFINITY })],
    ['undefined in a property', withInput({ topic: undefined })],
    ['undefined in an array', withInput({ topics: ['a', undefined] })],
    ['a Map', withInput({ index: new Map([['a', 1]]) })],
    ['a Set', withInput({ tags: new Set(['a']) })],
    ['a symbol', withInput({ marker: Symbol('x') })],
    ['a class instance', withInput({ thing: new (class Thing {})() })],
  ];

  for (const [name, document] of rejected) {
    it(`rejects ${name}`, () => {
      const result = validateRuntimeStep(document);

      assert.equal(result.ok, false, `${name} was accepted`);
      assert.match(result.issues[0].message, /is not JSON/);
    });
  }

  it('rejects a Date even though an object schema would accept it', () => {
    // The trap this guard exists for: no own enumerable properties, so the
    // schema sees `{}` and only serialisation reveals the difference.
    assert.deepEqual(Object.keys(new Date()), []);
    assert.equal(validateRuntimeStep(withInput(new Date())).ok, false);
  });

  it('names where the offending value was', () => {
    const result = validateRuntimeStep(
      withInput({ nested: { list: [1, Number.NaN] } }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.issues[0].path, '/input/nested/list[1]');
  });

  it('rejects a circular structure rather than throwing on it', () => {
    const input = { name: 'loop' };
    input.self = input;

    const result = validateRuntimeStep(withInput(input));

    assert.equal(result.ok, false);
    assert.match(result.issues[0].message, /circular/);
  });

  it('reports an unsafe value before any schema complaint', () => {
    const result = validateExecutionDocument('safeFailure', {
      version: '1',
      code: Number.NaN,
    });

    assert.equal(result.ok, false);
    assert.equal(result.issues.length, 1);
    assert.match(result.issues[0].message, /is not JSON/);
  });

  it('still reports schema problems for a document that is plain JSON', () => {
    const result = validateSafeFailure({
      version: '1',
      code: 'not-a-code',
    });

    assert.equal(result.ok, false);
    assert.match(JSON.stringify(result.issues), /allowed values|equal to one/);
  });
});

describe('the size budget the schema cannot express', () => {
  it('matches the deployed request ceiling', () => {
    assert.equal(EXECUTION_PAYLOAD_BUDGET_BYTES, 1_048_576);
  });

  it('accepts a document that is large but within budget', () => {
    const result = validateRuntimeStep(
      withInput({ body: 'x'.repeat(60_000) }),
    );

    assert.equal(result.ok, true);
  });

  it('rejects a document that satisfies every field bound and is still too big', () => {
    const document = withInput({
      chapters: Array.from({ length: 32 }, () => 'x'.repeat(65_536)),
    });

    // Each string is at its maximum and the array is well inside its own.
    assert.equal(validateRuntimeStep(document).ok, false);
    assert.match(
      validateRuntimeStep(document).issues[0].message,
      /over the 1048576-byte budget/,
    );
  });
});

describe('the aggregate context budget', () => {
  it('matches the declared 12000 code points ceiling', () => {
    assert.equal(EXECUTION_CONTEXT_BUDGET_CODE_POINTS, 12_000);
  });

  it('accepts context passages whose total code points are within budget', () => {
    const result = validateRuntimeStep({
      ...step,
      context: [
        {
          documentId: 'doc_1',
          chunkId: 'chunk_1',
          text: 'a'.repeat(6000),
        },
        {
          documentId: 'doc_2',
          chunkId: 'chunk_2',
          text: 'b'.repeat(6000),
        },
      ],
    });

    assert.equal(result.ok, true);
  });

  it('rejects context passages whose total code points exceed 12000', () => {
    const result = validateRuntimeStep({
      ...step,
      context: [
        {
          documentId: 'doc_1',
          chunkId: 'chunk_1',
          text: 'a'.repeat(7000),
        },
        {
          documentId: 'doc_2',
          chunkId: 'chunk_2',
          text: 'b'.repeat(6000),
        },
      ],
    });

    assert.equal(result.ok, false);
    assert.match(result.issues[0].message, /over the 12000-code-point budget/);
    assert.equal(result.issues[0].path, '/context');
  });

  it('counts Unicode code points rather than code units or bytes', () => {
    // Emojis are 2 UTF-16 code units (or 4 bytes) but 1 Unicode code point.
    // 6001 emojis = 6001 code points each -> 12002 code points total > 12000.
    const result = validateRuntimeStep({
      ...step,
      context: [
        {
          documentId: 'doc_1',
          chunkId: 'chunk_1',
          text: '👋'.repeat(6001),
        },
        {
          documentId: 'doc_2',
          chunkId: 'chunk_2',
          text: '🚀'.repeat(6001),
        },
      ],
    });

    assert.equal(result.ok, false);
    assert.match(result.issues[0].message, /12002 code points, over the 12000-code-point budget/);
  });
});
