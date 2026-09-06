import { existsSync } from 'node:fs';
import path from 'node:path';

import { DEFAULT_LOCALE } from '@repo/i18n-core';
export function resolveTranslationsPath(moduleDir?: string): string {
  // `moduleDir` is absent only when the code runs straight from TypeScript
  // (Jest's ESM transform, ts-node). That is also the signal for *which tree
  // is authoritative*: running from source means `src/i18n` wins, otherwise a
  // stale `dist/i18n` from an older build would silently shadow the files
  // being edited — and tests would assert against yesterday's translations.
  const candidates = moduleDir
    ? [
        path.join(moduleDir, '../../../i18n/'),
        path.join(moduleDir, '../../i18n/'),
        path.join(process.cwd(), 'dist/i18n/'),
        path.join(process.cwd(), 'dist/src/i18n/'),
      ]
    : [
        path.join(process.cwd(), 'src/i18n/'),
        path.join(process.cwd(), 'dist/i18n/'),
        path.join(process.cwd(), 'dist/src/i18n/'),
      ];

  const found = candidates.find((candidate) =>
    // Probing a known file rather than the directory: an empty leftover
    // folder would otherwise pass and defeat the point of this check.
    existsSync(path.join(candidate, DEFAULT_LOCALE, 'errors.json')),
  );

  if (!found) {
    throw new Error(
      '[i18n] No translation files found. Looked in:\n' +
        candidates.map((candidate) => `  - ${candidate}`).join('\n') +
        '\nIf this is a production build, check the "assets" entry in nest-cli.json.',
    );
  }

  return found;
}

export function currentModuleDir(): string | undefined {
  return typeof __dirname === 'undefined' ? undefined : __dirname;
}
