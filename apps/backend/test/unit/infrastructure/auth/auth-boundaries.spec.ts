import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC_DIR = path.join(process.cwd(), 'src');
const AUTH_DIR = path.join(SRC_DIR, 'infrastructure/auth');

const PROVIDER_SDKS = [
  'resend',
  'nodemailer',
  '@aws-sdk',
  '@aws-sdk/client-sesv2',
  'postmark',
];

const authSourceFiles = readdirSync(AUTH_DIR).filter(
  (file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'),
);

function importsOf(file: string): string[] {
  const source = readFileSync(path.join(AUTH_DIR, file), 'utf8');

  return [...source.matchAll(/from\s+'([^']+)'|import\s+'([^']+)'/g)].map(
    (match) => match[1] ?? match[2] ?? '',
  );
}

function collectSources(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);

    if (statSync(full).isDirectory()) {
      if (entry === 'generated' || entry === 'i18n') continue;
      collectSources(full, found);
      continue;
    }

    if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) found.push(full);
  }

  return found;
}

const allSources = collectSources(SRC_DIR);

function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const relative = (file: string) => path.relative(SRC_DIR, file);

const eachAuthFile = authSourceFiles.map((file) => [file] as const);

describe('infrastructure/auth boundaries', () => {
  it('has sources to check', () => {
    expect(authSourceFiles.length).toBeGreaterThan(0);
    expect(allSources.length).toBeGreaterThan(0);
  });

  it.each(eachAuthFile)('%s does not import a mail provider SDK', (file) => {
    const offending = importsOf(file).filter((specifier) =>
      PROVIDER_SDKS.some((sdk) => specifier.startsWith(sdk)),
    );

    expect(offending).toEqual([]);
  });

  it.each(eachAuthFile)('%s does not reach for a mail transport', (file) => {
    expect(importsOf(file)).not.toContainEqual(
      expect.stringMatching(/transport/i),
    );
  });

  it.each(eachAuthFile)('%s does not read ambient i18n context', (file) => {
    expect(importsOf(file)).not.toContain('nestjs-i18n');
  });

  it('reaches mail only through the module surface', () => {
    for (const file of authSourceFiles) {
      const crossModuleMailImports = importsOf(file).filter(
        (specifier) =>
          specifier.startsWith('../') && specifier.includes('mail'),
      );

      for (const specifier of crossModuleMailImports) {
        expect(specifier).toBe('../mail');
      }
    }
  });
});

function withoutGuardTable(code: string): string {
  const start = code.indexOf('export const SUPER_ADMIN_GUARDED_PATHS');
  if (start === -1) return code;

  const end = code.indexOf('\n  };', start);
  if (end === -1) return code;

  return code.slice(0, start) + code.slice(end);
}

describe('authorization invariants', () => {
  const ROLE_DEFINITION_FILES = ['infrastructure/auth/permissions.ts'];

  const ROLE_NAMES = ['super_admin', 'owner'];

  it('never compares a role field against a string literal', () => {
    const offenders: string[] = [];

    for (const file of allSources) {
      const code = codeOf(file);
      if (/(?<!typeof\s)\brole\s*[!=]==?\s*['"`]/.test(code)) {
        offenders.push(relative(file));
      }
      if (/\brole\s*\)\s*\.\s*includes\s*\(/.test(code))
        offenders.push(relative(file));
    }

    expect(offenders).toEqual([]);
  });

  it('names a role only where roles are defined', () => {
    const offenders: string[] = [];

    for (const file of allSources) {
      const name = relative(file);
      if (ROLE_DEFINITION_FILES.includes(name)) continue;

      const code = codeOf(file);
      for (const role of ROLE_NAMES) {
        if (code.includes(`'${role}'`) || code.includes(`"${role}"`)) {
          offenders.push(`${name} names ${role}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('does not use role-name decorators for authorization', () => {
    const offenders: string[] = [];

    for (const file of allSources) {
      const code = codeOf(file);
      if (/@Roles\s*\(/.test(code) || /@OrgRoles\s*\(/.test(code)) {
        offenders.push(relative(file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('never protects a route with @RequireActiveOrg alone', () => {
    const offenders: string[] = [];

    for (const file of allSources) {
      const code = codeOf(file);
      if (!code.includes('@RequireActiveOrg')) continue;

      const segments = code.split('@RequireActiveOrg');
      for (const segment of segments.slice(1)) {
        const handler = segment.slice(0, 400);
        const authorized =
          handler.includes('@MemberHasPermission') ||
          handler.includes('@UserHasPermission');
        if (!authorized) offenders.push(relative(file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('never calls Better Auth hard user deletion', () => {
    const offenders: string[] = [];

    for (const file of allSources) {
      const code = withoutGuardTable(codeOf(file));
      if (
        /\bremoveUser\s*\(/.test(code) ||
        code.includes('/admin/remove-user')
      ) {
        offenders.push(relative(file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('never calls Better Auth hard organization deletion', () => {
    const offenders: string[] = [];

    for (const file of allSources) {
      const code = codeOf(file);
      if (
        /\bdeleteOrganization\s*\(/.test(code) ||
        code.includes('/organization/delete')
      ) {
        offenders.push(relative(file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('configures no session cookie cache or secondary storage', () => {
    const offenders: string[] = [];

    for (const file of allSources) {
      const code = codeOf(file);
      for (const forbidden of ['cookieCache', 'secondaryStorage']) {
        if (code.includes(forbidden)) {
          offenders.push(`${relative(file)} mentions ${forbidden}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  const PLATFORM_MODULES_AUTH_MAY_NOT_USE = ['redis', 'queue', 'outbox'];

  it.each(eachAuthFile)('%s does not reach for Redis or a queue', (file) => {
    const offending = importsOf(file).filter((specifier) => {
      if (specifier === 'ioredis' || specifier === 'bullmq') return true;

      const segments = specifier.split('/');
      return PLATFORM_MODULES_AUTH_MAY_NOT_USE.some((name) =>
        segments.includes(name),
      );
    });

    expect(offending).toEqual([]);
  });

  it('does not document Better Auth paths with Nest controllers', () => {
    const offenders: string[] = [];

    for (const file of allSources) {
      const code = codeOf(file);
      for (const match of code.matchAll(
        /@Controller\s*\(\s*['"]([^'"]*)['"]/g,
      )) {
        if ((match[1] ?? '').replace(/^\//, '').startsWith('api/auth')) {
          offenders.push(`${relative(file)} mounts on ${match[1]}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
