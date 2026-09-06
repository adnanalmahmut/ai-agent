import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { validateExecutionDocument } from '../dist/validate.js';

const fixtures = fileURLToPath(
  new URL('../../../contracts/fixtures/execution/v1/', import.meta.url),
);

async function load(kind) {
  const directory = join(fixtures, kind);
  const names = (await readdir(directory)).filter((n) => n.endsWith('.json'));

  return Promise.all(
    names.map(async (name) => ({
      name: basename(name, '.json'),
      ...JSON.parse(await readFile(join(directory, name), 'utf8')),
    })),
  );
}

const valid = await load('valid');
const invalid = await load('invalid');

describe('golden fixtures', () => {
  it('there are fixtures on both sides', () => {
    assert.ok(valid.length >= 10, `only ${valid.length} valid fixtures`);
    assert.ok(invalid.length >= 15, `only ${invalid.length} invalid fixtures`);
  });

  for (const fixture of valid) {
    it(`accepts ${fixture.name}`, () => {
      const result = validateExecutionDocument(fixture.kind, fixture.document);

      assert.deepEqual(result.ok ? [] : result.issues, []);
    });
  }

  for (const fixture of invalid) {
    it(`rejects ${fixture.name}`, () => {
      const result = validateExecutionDocument(fixture.kind, fixture.document);

      assert.equal(result.ok, false, fixture.why ?? 'should have been rejected');
      assert.ok(result.issues.length > 0);
    });
  }

  it('every invalid fixture says why it is invalid', () => {
    for (const fixture of invalid) {
      assert.equal(typeof fixture.why, 'string', `${fixture.name} has no reason`);
      assert.ok(fixture.why.length > 20, `${fixture.name} reason is too thin`);
    }
  });

  it('every fixture names a document kind the contract defines', () => {
    const kinds = new Set([
      'runtimeStep',
      'runtimeStepResult',
      'toolInvocation',
      'safeFailure',
      'artifactRef',
      'embedding',
    ]);

    for (const fixture of [...valid, ...invalid]) {
      assert.ok(kinds.has(fixture.kind), `${fixture.name}: ${fixture.kind}`);
    }
  });
});
