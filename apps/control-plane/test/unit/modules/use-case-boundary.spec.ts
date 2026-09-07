import { describe, expect, it } from '@jest/globals';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../src',
);
const MODULES_ROOT = join(SOURCE_ROOT, 'modules');
const HANDLERS_ROOT = join(SOURCE_ROOT, 'workers', 'handlers');

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

  // A package compiled for Node's ESM resolver writes `./x.js` and ships
  // `./x.ts`, so the walk has to follow the specifier as written.
  const withoutJs = base.endsWith('.js') ? base.slice(0, -'.js'.length) : base;

  for (const candidate of [
    `${base}.ts`,
    `${withoutJs}.ts`,
    join(base, 'index.ts'),
  ]) {
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

describe.each([
  ['runs', 2, 'ai/execution/agent-run.service.ts'],
  ['approvals', 1, 'ai/tools/tool-authorization.service.ts'],
  ['execution', 2, 'ai/execution/agent-run.service.ts'],
])('the %s use-case boundary', (family, useCaseCount, mustReach) => {
  const boundaryFiles = sourceFilesUnder(join(MODULES_ROOT, family));
  // A composition root is allowed to name a transport; a use case is not, so
  // the transitive walk starts from the callable surface alone.
  const useCases = boundaryFiles.filter((file) =>
    file.endsWith('.use-case.ts'),
  );
  const { files, packages } = reachableFrom(useCases);
  const reached = [...files].map((file) => relative(SOURCE_ROOT, file)).sort();

  it('has something to check', () => {
    expect(useCases.length).toBe(useCaseCount);
    expect(files.size).toBeGreaterThan(useCases.length);
  });

  it.each(['bullmq', 'ioredis'])(
    'never imports %s directly, anywhere in the boundary',
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

  it('does reach the authority it decides with, so the walk is not vacuous', () => {
    expect(reached).toContain(mustReach);
  });
});

// The other half of the same statement: what the queue side is left holding.
describe('the queue handlers the use cases replaced policy in', () => {
  const ALLOWED = [
    '@nestjs/common',
    'bullmq',
    'nestjs-pino',
    '../../infrastructure/queue',
    '../../modules/runs',
    '../../modules/approvals',
  ];

  it.each(['agent-execution.handler.ts', 'side-effect-execution.handler.ts'])(
    '%s imports a transport, a logger and one use case, and nothing else',
    (name) => {
      const specifiers = specifiersIn(join(HANDLERS_ROOT, name));

      expect(specifiers.length).toBeGreaterThan(0);
      for (const specifier of specifiers) expect(ALLOWED).toContain(specifier);
    },
  );

  it.each(['agent-execution.handler.ts', 'side-effect-execution.handler.ts'])(
    '%s reaches no database, registry or tool implementation',
    (name) => {
      const source = readFileSync(join(HANDLERS_ROOT, name), 'utf8');

      for (const authority of [
        'PrismaService',
        'ToolRegistry',
        'TOOL_IMPLEMENTATIONS',
        'AgentDefinitionRegistry',
        'ToolExecutionService',
        'AgentRunService',
      ]) {
        expect(source).not.toContain(authority);
      }
    },
  );
});

/**
 * The other direction of RF-16's claim: what a service on the far side of the
 * execution boundary has to have in order to speak it.
 *
 * The answer has to be "the contract package and nothing else", because every
 * name on this list is either a credential, a connection or a Control Plane
 * class — and a runtime that needs one of them has not been given a boundary,
 * it has been given the database with extra steps.
 */
describe('what an out-of-process execution consumer must import', () => {
  const CONTRACT_ROOT = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../../packages/execution-contracts/src',
  );

  const { files, packages } = reachableFrom(
    sourceFilesUnder(CONTRACT_ROOT).filter((file) => file.endsWith('index.ts')),
  );

  it('has something to check', () => {
    expect(files.size).toBeGreaterThan(1);
  });

  it.each([
    '@nestjs/common',
    '@nestjs/core',
    '@prisma/client',
    'bullmq',
    'ioredis',
    'better-auth',
    'pg',
  ])('needs no %s', (forbidden) => {
    expect([...packages]).not.toContain(forbidden);
  });

  it('reaches no Control Plane source at all', () => {
    expect([...files].filter((file) => file.startsWith(SOURCE_ROOT))).toEqual(
      [],
    );
  });

  it('names no Control Plane authority, connection or credential', () => {
    const surface = [...files]
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');

    for (const authority of [
      'PrismaService',
      'DATABASE_URL',
      'REDIS_URL',
      'BETTER_AUTH_SECRET',
      'AgentRunService',
      'ToolAuthorizationService',
      'ToolExecutionService',
      'AgentDefinitionRegistry',
    ]) {
      expect(surface).not.toContain(authority);
    }
  });
});
