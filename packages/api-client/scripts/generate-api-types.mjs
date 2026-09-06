/**
 * Generates `src/generated/application-api.generated.ts` from the Backend's
 * Application OpenAPI document.
 *
 * The Backend's Zod contracts are the authored source. This script only
 * orchestrates the standard pipeline — emit the document, run
 * `openapi-typescript` over it, discard the intermediate JSON. It does not
 * read, filter or translate schemas itself; the generator does that.
 *
 * The Backend emits the document from route metadata in Nest's preview mode,
 * so this needs no running API, no database, no Redis and no credentials. It
 * does need the Backend compiled, which is why the build runs first.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const outputPath = join(
  packageDirectory,
  'src/generated/application-api.generated.ts',
);

// A failing step has already printed why it failed, so this reports which
// step it was and stops, rather than adding a Node stack trace on top.
const run = (command, args, cwd) => {
  const { status } = spawnSync(command, args, { cwd, stdio: 'inherit' });

  if (status !== 0) throw new Error(`Failed: ${command} ${args.join(' ')}`);
};

// Outside the repository, so a failed run cannot leave a stray document
// behind for the next run to pick up or for review to see.
const scratch = await mkdtemp(join(tmpdir(), 'application-openapi-'));
const documentPath = join(scratch, 'openapi.json');

try {
  run('pnpm', ['--filter', 'control-plane', 'run', 'build'], repositoryRoot);
  run(
    'pnpm',
    ['--filter', 'control-plane', 'run', 'openapi:emit', documentPath],
    repositoryRoot,
  );
  run(
    'pnpm',
    ['exec', 'openapi-typescript', documentPath, '--output', outputPath],
    packageDirectory,
  );
} catch (error) {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
