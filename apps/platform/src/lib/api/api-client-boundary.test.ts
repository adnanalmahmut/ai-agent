import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The browser must not be able to reach the server.
 *
 * `@repo/api-client` splits its transports across two subpaths, and the whole
 * value of that split is that cookie forwarding and `next/headers` cannot end
 * up in a browser bundle by way of an import somebody added to a shared file.
 * A grep over the package would not show that: the question is not whether a
 * module mentions `next/headers`, it is whether the browser entry can reach a
 * module that imports it.
 *
 * So this walks the import graph from each entry and reports what it can
 * reach. No bundler, no new tooling -- the graph is the assertion.
 */

const packageSource = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../packages/api-client/src',
);

const IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

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

/** Every module and every external package an entry can reach, transitively. */
function reachableFrom(entry: string): {
  modules: Set<string>;
  packages: Set<string>;
} {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const queue = [resolve(packageSource, entry)];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (modules.has(file)) continue;
    modules.add(file);

    for (const specifier of specifiersIn(file)) {
      if (!specifier.startsWith('.')) {
        packages.add(specifier);
        continue;
      }

      const resolved = resolve(dirname(file), specifier);
      queue.push(resolved.endsWith('.ts') ? resolved : `${resolved}.ts`);
    }
  }

  return { modules, packages };
}

const SERVER_ONLY_PACKAGES = ['server-only', 'next/headers', 'next/server'];

describe.each([
  ['the public entry', 'index.ts'],
  ['the browser entry', 'browser.ts'],
])('%s', (_name, entry) => {
  it('imports nothing outside the package', () => {
    expect([...reachableFrom(entry).packages]).toEqual([]);
  });

  it('cannot reach a server-only module', () => {
    const { packages } = reachableFrom(entry);

    for (const forbidden of SERVER_ONLY_PACKAGES) {
      expect(packages.has(forbidden)).toBe(false);
    }
  });

  it('cannot reach the server transport', () => {
    const { modules } = reachableFrom(entry);

    expect([...modules].some((file) => file.endsWith('/server.ts'))).toBe(
      false,
    );
  });
});

describe('the server entry', () => {
  it('is a framework-agnostic primitive, not a Next module', () => {
    // Reading the request's cookie is the application's job; this one is
    // handed the value. That is what keeps the package importable by an
    // application that is not Next, and `next/headers` out of it entirely.
    const { packages } = reachableFrom('server.ts');

    expect([...packages]).toEqual([]);
  });
});

describe('the whole package', () => {
  it('depends on no application and no framework at runtime', () => {
    const everything = [
      ...reachableFrom('index.ts').packages,
      ...reachableFrom('browser.ts').packages,
      ...reachableFrom('server.ts').packages,
      ...reachableFrom('generated/index.ts').packages,
    ];

    expect(everything).toEqual([]);
  });
});
