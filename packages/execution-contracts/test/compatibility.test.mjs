import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020.js';

import { EXECUTION_V1_SCHEMAS } from '../dist/generated/schemas.js';

const validDirectory = fileURLToPath(
  new URL('../../../contracts/fixtures/execution/v1/valid/', import.meta.url),
);

const corpus = await Promise.all(
  (await readdir(validDirectory))
    .filter((name) => name.endsWith('.json'))
    .map(async (name) =>
      JSON.parse(await readFile(join(validDirectory, name), 'utf8')),
    ),
);

const KIND_TO_ID = {
  runtimeStep: 'runtime-step.schema.json',
  runtimeStepResult: 'runtime-step-result.schema.json',
  toolInvocation: 'tool-invocation.schema.json',
  safeFailure: 'safe-failure.schema.json',
  artifactRef: 'artifact-ref.schema.json',
  embedding: 'embedding.schema.json',
};
const BASE = 'https://contracts.ai-agent.local/execution/v1/';

/**
 * The mechanical question for backward-reader compatibility: does every
 * document valid under the published contract still validate under the
 * candidate reader? Rolling forward compatibility is a separate direction, and
 * the old-reader tests below cover it.
 *
 * This is not a schema-diff engine and is not trying to be. It applies a
 * candidate change to a copy of the schemas and re-runs the published corpus.
 */
function corpusStillValidates(change) {
  const schemas = structuredClone(
    EXECUTION_V1_SCHEMAS.map(([, schema]) => schema),
  );
  const byId = new Map(schemas.map((schema) => [schema.$id, schema]));

  change(byId);

  const ajv = new Ajv2020({ strict: true, allErrors: true, schemas });
  addFormats(ajv, ['date-time']);

  return corpus.every((fixture) => {
    const validate = ajv.getSchema(`${BASE}${KIND_TO_ID[fixture.kind]}`);

    return validate(fixture.document) === true;
  });
}

const schemaFor = (byId, id) => byId.get(`${BASE}${id}`);

describe('what may change inside version 1', () => {
  it('the corpus is not empty, so the question means something', () => {
    assert.ok(corpus.length >= 10);
    assert.equal(corpusStillValidates(() => {}), true);
  });

  describe('backward reader compatibility: new reader accepts old documents', () => {
    it('new reader accepts old document after optional-property widening', () => {
      assert.equal(
        corpusStillValidates((byId) => {
          const failure = schemaFor(byId, 'safe-failure.schema.json');
          failure.properties.observedAt = { type: 'string' };
        }),
        true,
      );
    });

    it('raising a ceiling', () => {
      assert.equal(
        corpusStillValidates((byId) => {
          const result = schemaFor(byId, 'runtime-step-result.schema.json');
          result.$defs.toolRequest.properties.invocations.maxItems = 24;
        }),
        true,
      );
    });

    it('new reader accepts old enum member after closed vocabulary widening', () => {
      assert.equal(
        corpusStillValidates((byId) => {
          schemaFor(byId, 'safe-failure.schema.json').properties.code.enum.push(
            'rate_limited',
          );
        }),
        true,
      );
    });
  });

  describe('forward compatibility limits: old closed reader rejects widened documents', () => {
    it('old closed reader rejects new document emitting the newly added property', () => {
      const ajv = new Ajv2020({
        strict: true,
        allErrors: true,
        schemas: EXECUTION_V1_SCHEMAS.map(([, schema]) => schema),
      });
      addFormats(ajv, ['date-time']);
      const validate = ajv.getSchema(`${BASE}safe-failure.schema.json`);

      const widenedDocument = {
        version: '1',
        code: 'timeout',
        observedAt: '2026-09-07T00:00:00.000Z',
      };

      assert.equal(validate(widenedDocument), false);
    });

    it('old closed reader rejects new document emitting a newly added enum member', () => {
      const ajv = new Ajv2020({
        strict: true,
        allErrors: true,
        schemas: EXECUTION_V1_SCHEMAS.map(([, schema]) => schema),
      });
      addFormats(ajv, ['date-time']);
      const validate = ajv.getSchema(`${BASE}safe-failure.schema.json`);

      const widenedDocument = {
        version: '1',
        code: 'rate_limited',
      };

      assert.equal(validate(widenedDocument), false);
    });
  });

  describe('the one correction v1 took before its first consumer', () => {
    /** The published step that actually carries a passage to reason about. */
    const publishedStep = () => {
      const fixture = corpus.find(
        ({ kind, document }) =>
          kind === 'runtimeStep' && document.context.length > 0,
      );

      assert.ok(fixture, 'the corpus has no runtime step with context');

      return fixture.document;
    };

    const currentReader = () => {
      const ajv = new Ajv2020({
        strict: true,
        allErrors: true,
        schemas: EXECUTION_V1_SCHEMAS.map(([, schema]) => schema),
      });
      addFormats(ajv, ['date-time']);

      return ajv.getSchema(`${BASE}runtime-step.schema.json`);
    };

    it('a step carries the whole runtime-facing input, not a subset of it', () => {
      for (const { kind, document } of corpus) {
        if (kind !== 'runtimeStep') continue;

        // The two an external runtime cannot reconstruct for itself: the
        // normalised organization configuration, and which knowledge space
        // each passage came from.
        assert.equal(typeof document.configuration, 'object');
        assert.notEqual(document.configuration, null);

        for (const passage of document.context) {
          assert.equal(typeof passage.space, 'string');
        }
      }
    });

    it('the shape published before RF-16 no longer validates, which is what made this a pre-consumer correction', () => {
      const validate = currentReader();
      const { configuration: _dropped, ...withoutConfiguration } =
        publishedStep();

      assert.equal(validate(withoutConfiguration), false);

      const step = publishedStep();
      assert.equal(
        validate({
          ...step,
          context: step.context.map(({ space: _space, ...rest }) => rest),
        }),
        false,
      );
    });

    it('making the same correction later would be a version 2 change', () => {
      // Requiring a property the corpus did not carry is the breaking move the
      // table in contracts/README.md names. Re-issuing the corpus is what it
      // costs, and it is only free while no consumer reads v1 yet.
      assert.equal(
        corpusStillValidates((byId) => {
          const step = schemaFor(byId, 'runtime-step.schema.json');
          step.properties.deliveredAt = { type: 'string' };
          step.required.push('deliveredAt');
        }),
        false,
      );
    });
  });

  describe('breaking: version 2, once a consumer exists', () => {
    it('making an optional property required', () => {
      assert.equal(
        corpusStillValidates((byId) => {
          const failure = schemaFor(byId, 'safe-failure.schema.json');
          failure.properties.observedAt = { type: 'string' };
          failure.required.push('observedAt');
        }),
        false,
      );
    });

    it('removing a member of a closed vocabulary', () => {
      assert.equal(
        corpusStillValidates((byId) => {
          const code = schemaFor(byId, 'safe-failure.schema.json').properties
            .code;
          code.enum = code.enum.filter((value) => value !== 'timeout');
        }),
        false,
      );
    });

    it('narrowing a ceiling', () => {
      assert.equal(
        corpusStillValidates((byId) => {
          schemaFor(byId, 'runtime-step.schema.json').properties.context.maxItems = 0;
        }),
        false,
      );
    });

    it('changing a field type', () => {
      assert.equal(
        corpusStillValidates((byId) => {
          schemaFor(byId, 'runtime-step.schema.json').properties.attempt = {
            type: 'string',
          };
        }),
        false,
      );
    });

    it('changing the version itself', () => {
      assert.equal(
        corpusStillValidates((byId) => {
          schemaFor(byId, 'runtime-step.schema.json').properties.version = {
            const: '2',
          };
        }),
        false,
      );
    });

    it('removing a property the corpus uses', () => {
      assert.equal(
        corpusStillValidates((byId) => {
          const step = schemaFor(byId, 'runtime-step.schema.json');
          delete step.properties.grantedTools;
          step.required = step.required.filter((n) => n !== 'grantedTools');
        }),
        false,
      );
    });
  });
});
