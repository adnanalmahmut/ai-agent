import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = fileURLToPath(new URL('..', import.meta.url));
const standaloneApp = fileURLToPath(
  new URL('../.next/standalone/apps/platform/', import.meta.url),
);

await mkdir(join(standaloneApp, '.next'), { recursive: true });
await Promise.all([
  cp(join(appDirectory, '.next/static'), join(standaloneApp, '.next/static'), {
    recursive: true,
  }),
  cp(join(appDirectory, 'public'), join(standaloneApp, 'public'), {
    recursive: true,
  }),
]);
