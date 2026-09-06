import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { EXECUTION_V1_SCHEMAS } from '../dist/generated/schemas.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const contractsDirectory = fileURLToPath(
  new URL('../../../contracts/execution/v1/', import.meta.url),
);

const authored = (await readdir(contractsDirectory)).filter((name) =>
  name.endsWith('.schema.json'),
);

describe('one source, and a package that carries no runtime of its own', () => {
  it('inlines exactly the schemas that were authored', async () => {
    assert.equal(EXECUTION_V1_SCHEMAS.length, authored.length);

    for (const name of authored) {
      const source = JSON.parse(
        await readFile(join(contractsDirectory, name), 'utf8'),
      );
      const [, inlined] =
        EXECUTION_V1_SCHEMAS.find(([id]) => id === source.$id) ?? [];

      assert.ok(inlined, `${name} is not in the generated bundle`);
      assert.deepEqual(inlined, source, `${name} drifted from its source`);
    }
  });

  it('declares no dependency on an application, a database or a broker', async () => {
    const manifest = JSON.parse(
      await readFile(join(packageRoot, 'package.json'), 'utf8'),
    );
    const declared = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    });

    for (const forbidden of [
      '@nestjs/common',
      '@nestjs/core',
      '@prisma/client',
      'prisma',
      'bullmq',
      'ioredis',
      'pg',
      'control-plane',
      '@repo/api-client',
    ]) {
      assert.ok(
        !declared.includes(forbidden),
        `${forbidden} has no business here`,
      );
    }
  });

  it('writes no second description of the same wire shape by hand', async () => {
    const sources = (await readdir(join(packageRoot, 'src'))).filter((name) =>
      name.endsWith('.ts'),
    );

    for (const name of sources) {
      const text = await readFile(join(packageRoot, 'src', name), 'utf8');

      // Every exported document type comes from the generated view.
      for (const shape of ['RuntimeStep', 'ToolInvocation', 'SafeFailure']) {
        assert.ok(
          !new RegExp(`(interface|type)\\s+${shape}\\b`).test(text),
          `${name} redeclares ${shape}`,
        );
      }
    }
  });

  it('generates with the database and broker pointed at closed ports', () => {
    // Not "no variable is set" — that only says the machine happened to be
    // clean. Point them at addresses nothing is listening on: anything that
    // quietly dialled out would hang or fail here.
    const unreachable = {
      DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/none',
      REDIS_URL: 'redis://127.0.0.1:1',
    };

    const generated = spawnSync(
      process.execPath,
      [join(packageRoot, 'scripts/generate.mjs')],
      {
        cwd: packageRoot,
        env: { ...process.env, ...unreachable },
        encoding: 'utf8',
        timeout: 120_000,
      },
    );

    assert.equal(generated.status, 0, generated.stderr);
    assert.match(generated.stdout, /Generated \d+ execution v1 schemas\./);
  });

  it('validates with the same variables pointed nowhere', () => {
    const checked = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { validateSafeFailure } from '${join(packageRoot, 'dist/index.js')}';
         const ok = validateSafeFailure({ version: '1', code: 'timeout', retryable: true }).ok;
         if (!ok) { process.exit(2); }
         console.log('validated');`,
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/none',
          REDIS_URL: 'redis://127.0.0.1:1',
        },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );

    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /validated/);
  });
});
