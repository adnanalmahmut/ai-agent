import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The browser must not be able to reach the server.
 *
 * The question is not whether a client component mentions the session helper
 * — it is whether one can reach a module that imports it, through however
 * many files. A grep does not answer that; walking the graph does.
 *
 * Same technique the API client's boundary test uses, pointed at this
 * application's own source instead of a package's.
 */

const sourceDirectory = join(process.cwd(), 'src');

const IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

/** Anything that only makes sense with a request, a secret or Node behind it. */
const SERVER_ONLY = [
  'server-only',
  'next/headers',
  'next/server',
  '@repo/api-client/server',
  'node:fs',
  'node:path',
];

function filesUnder(root: string): string[] {
  const found: string[] = [];
  const queue = [root];

  while (queue.length > 0) {
    const directory = queue.pop() as string;

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (/\.tsx?$/.test(entry.name)) found.push(path);
    }
  }

  return found.sort();
}

function specifiersIn(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const found: string[] = [];

  for (const pattern of [IMPORT, SIDE_EFFECT_IMPORT]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match !== null) {
      found.push(match[1]);
      match = pattern.exec(source);
    }
  }

  return found;
}

function resolveModule(from: string, specifier: string): string | null {
  const base = specifier.startsWith('@/')
    ? join(sourceDirectory, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(from), specifier)
      : null;

  if (base === null) return null;

  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate) && /\.tsx?$/.test(candidate)) return candidate;
  }

  return null;
}

/** Every module and every package an entry can reach, transitively. */
function reachableFrom(entry: string): {
  modules: Set<string>;
  packages: Set<string>;
} {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (modules.has(file)) continue;
    modules.add(file);

    for (const specifier of specifiersIn(file)) {
      const resolved = resolveModule(file, specifier);

      if (resolved === null) packages.add(specifier);
      else queue.push(resolved);
    }
  }

  return { modules, packages };
}

const clientEntries = filesUnder(sourceDirectory).filter(
  (file) =>
    !file.includes('.test.') &&
    /^\s*['"]use client['"]/.test(readFileSync(file, 'utf8')),
);

describe('the client graph', () => {
  it('has client components to check', () => {
    // A boundary test that silently checks nothing is worse than none.
    expect(clientEntries.length).toBeGreaterThan(0);
  });

  it.each(clientEntries.map((file) => [relative(process.cwd(), file), file]))(
    '%s cannot reach a server-only module',
    (_name, entry) => {
      const { packages } = reachableFrom(entry);

      expect(
        SERVER_ONLY.filter((forbidden) => packages.has(forbidden)),
      ).toEqual([]);
    },
  );

  it.each(clientEntries.map((file) => [relative(process.cwd(), file), file]))(
    '%s cannot reach the session or the server configuration',
    (_name, entry) => {
      const { modules } = reachableFrom(entry);
      const reachable = [...modules].map((file) =>
        relative(sourceDirectory, file),
      );

      for (const forbidden of [
        'config/server.ts',
        'lib/api/server-request.ts',
        'features/auth/server-session.ts',
        'features/auth/admin-access.ts',
      ]) {
        expect(reachable).not.toContain(forbidden);
      }
    },
  );
});

describe('the server modules that hold the boundary', () => {
  it.each([
    'config/server.ts',
    'lib/api/server-request.ts',
    'features/auth/server-session.ts',
    'features/auth/admin-access.ts',
  ])('%s declares itself server-only', (module) => {
    const source = readFileSync(join(sourceDirectory, module), 'utf8');

    // The import is what makes a build fail rather than a review catch it.
    expect(source).toMatch(/import 'server-only';/);
  });
});

describe('the workspace boundary', () => {
  it('imports nothing from the customer application', () => {
    const offenders = filesUnder(sourceDirectory).filter((file) =>
      specifiersIn(file).some(
        (specifier) =>
          specifier.includes('apps/app') || /\.\.\/.*\/app\/src/.test(specifier),
      ),
    );

    expect(offenders.map((file) => relative(process.cwd(), file))).toEqual([]);
  });

  it('takes its shared code from packages', () => {
    const shared = new Set<string>();

    for (const file of filesUnder(sourceDirectory)) {
      for (const specifier of specifiersIn(file)) {
        if (specifier.startsWith('@repo/')) shared.add(specifier);
      }
    }

    expect([...shared].sort()).toEqual([
      '@repo/api-client',
      '@repo/api-client/server',
      '@repo/authz-policy',
      '@repo/i18n-core',
      '@repo/ui',
      '@repo/ui/globals.css',
    ]);
  });
});
