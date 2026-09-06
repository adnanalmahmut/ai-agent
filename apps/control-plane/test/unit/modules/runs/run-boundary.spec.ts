import { describe, expect, it } from '@jest/globals';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../src',
);
const RUNS_ROOT = join(SOURCE_ROOT, 'modules', 'runs');

// Prisma's client is machine-written and enormous; it is a leaf for this walk.
const OPAQUE = [join(SOURCE_ROOT, 'generated')];

function sourceFilesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFilesUnder(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

function specifiersIn(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const found = new Set<string>();

  // `from '…'` covers static imports, type-only imports and re-exports;
  // `import('…')` covers the dynamic form.
  for (const match of source.matchAll(/from\s+'([^']+)'/g)) found.add(match[1]);
  for (const match of source.matchAll(/import\('([^']+)'\)/g)) {
    found.add(match[1]);
  }

  return [...found];
}

function resolveRelative(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier);

  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/** Every module the runs boundary can reach, and every package it names. */
function reachableFrom(entryPoints: string[]): {
  files: Set<string>;
  packages: Set<string>;
} {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [...entryPoints];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    if (OPAQUE.some((prefix) => file.startsWith(prefix))) continue;

    for (const specifier of specifiersIn(file)) {
      if (!specifier.startsWith('.')) {
        packages.add(specifier);
        continue;
      }

      const resolved = resolveRelative(file, specifier);
      expect(resolved).not.toBeNull();
      queue.push(resolved!);
    }
  }

  return { files, packages };
}

describe('the run use-case boundary', () => {
  const boundaryFiles = sourceFilesUnder(RUNS_ROOT);
  // A composition root is allowed to name a transport; a use case is not, so
  // the transitive walk starts from the callable surface alone.
  const useCases = boundaryFiles.filter((file) =>
    file.endsWith('.use-case.ts'),
  );
  const { files, packages } = reachableFrom(useCases);
  const reached = [...files].map((file) => relative(SOURCE_ROOT, file)).sort();

  it('has something to check', () => {
    expect(useCases.length).toBe(2);
    expect(files.size).toBeGreaterThan(useCases.length);
  });

  it.each(['bullmq', 'ioredis'])(
    'is never imported directly alongside %s, anywhere in the boundary',
    (forbidden) => {
      for (const file of boundaryFiles) {
        expect(specifiersIn(file)).not.toContain(forbidden);
      }
    },
  );

  it('imports nothing from the queue infrastructure, anywhere in the boundary', () => {
    for (const file of boundaryFiles) {
      for (const specifier of specifiersIn(file)) {
        expect(specifier).not.toMatch(/(^|\/)queue(\/|$)/);
      }
    }
  });

  it.each(['bullmq', 'ioredis'])(
    'cannot reach %s, transitively',
    (forbidden) => {
      expect([...packages]).not.toContain(forbidden);
    },
  );

  it('cannot reach the queue infrastructure', () => {
    expect(
      reached.filter((file) => file.startsWith('infrastructure/queue')),
    ).toEqual([]);
  });

  it('cannot reach a concrete agent runtime implementation', () => {
    expect(
      reached.filter((file) => file.startsWith('ai/infrastructure/runtimes/')),
    ).toEqual([]);
  });

  it('names no transport concept on its own surface', () => {
    const surface = boundaryFiles
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');

    for (const term of ['attemptsStarted', 'attemptsMade', 'Job<', 'bullmq']) {
      expect(surface).not.toContain(term);
    }
  });

  it('does reach the durable run store, so the walk is not vacuous', () => {
    expect(reached).toContain('ai/execution/agent-run.service.ts');
    expect(reached).toContain('ai/execution/agent-runner.service.ts');
  });
});
