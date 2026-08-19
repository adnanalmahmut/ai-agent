import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Architectural invariants, enforced rather than described.
 *
 * Two groups: the dependency direction between auth and mail, and the
 * authorization rules that this feature exists to establish. All of them are
 * the kind of rule a reviewer would otherwise have to remember.
 */

const SRC_DIR = path.join(process.cwd(), 'src');
const AUTH_DIR = path.join(SRC_DIR, 'core/auth');

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

/** Every non-spec source file under `src/`, excluding generated output. */
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

/** Source with comments stripped, so prose describing a rule cannot break it. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const relative = (file: string) => path.relative(SRC_DIR, file);

const eachAuthFile = authSourceFiles.map((file) => [file] as const);

describe('core/auth boundaries', () => {
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

  /**
   * A transport is internal to the mail module. Auth reaching one directly
   * would bypass rendering, locale resolution and the failure handling that
   * make `dispatch` safe to call from an authentication callback.
   */
  it.each(eachAuthFile)('%s does not reach for a mail transport', (file) => {
    expect(importsOf(file)).not.toContainEqual(
      expect.stringMatching(/transport/i),
    );
  });

  /**
   * Better Auth mounts outside the Nest pipeline, so there is no ambient
   * request context on these paths at all. The locale is resolved from the
   * callback's own request and travels on the job.
   *
   * Asserted on imports rather than raw text: `I18nContext` is obtainable only
   * from `nestjs-i18n`, so the absence of that import is a complete proof —
   * and unlike a text scan it does not trip over prose that names the very
   * thing it forbids.
   */
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

describe('authorization invariants', () => {
  /**
   * Roles are permission bundles, so a role *name* must never be the thing a
   * decision is made on. Two independent reasons: `super_admin` is a superset
   * of `admin`, so `role === 'admin'` silently excludes it; and the set of
   * capabilities behind a name changes, while a permission does not.
   *
   * The two access-control definitions are the only files allowed to name a
   * role, because naming them is precisely their job.
   */
  const ROLE_DEFINITION_FILES = [
    'core/auth/auth-access.ts',
    'core/auth/organization-access.ts',
  ];

  const ROLE_NAMES = ['super_admin', 'owner'];

  it('never compares a role field against a string literal', () => {
    const offenders: string[] = [];

    for (const file of allSources) {
      const code = codeOf(file);
      // `x.role === 'admin'`, `role !== "owner"`, `user.role == 'user'`.
      // `typeof role === 'string'` is a *shape* check, not an authorization
      // decision, so it is excluded — narrowing an unknown column to a string
      // before handing it to the access-control evaluator is exactly right.
      if (/(?<!typeof\s)\brole\s*[!=]==?\s*['"`]/.test(code)) {
        offenders.push(relative(file));
      }
      // `['admin'].includes(role)` and friends
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

  /**
   * `@Roles` and `@OrgRoles` compare role strings from the session. They are
   * available in the library and deliberately unused: application code asks
   * what a principal may *do*, through `@UserHasPermission` and
   * `@MemberHasPermission`, which resolve against the database.
   */
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

  /**
   * The rule this whole feature turns on.
   *
   * `@RequireActiveOrg()` proves only that *an* organization is selected. It
   * proves nothing about membership or permission, so a route that carries it
   * alone would hand organization data to a session that merely set
   * `activeOrganizationId`. It may accompany a permission check; it may never
   * replace one.
   */
  it('never protects a route with @RequireActiveOrg alone', () => {
    const offenders: string[] = [];

    for (const file of allSources) {
      const code = codeOf(file);
      if (!code.includes('@RequireActiveOrg')) continue;

      // Split on the decorator and inspect each following handler for a
      // permission check before the next decorator block begins.
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

  /**
   * Better Auth's `removeUser` is hard, irreversible deletion. No role is
   * granted `user:delete`, and no application code calls the endpoint either —
   * so the policy holds even if a role definition were changed by mistake.
   */
  it('never calls Better Auth hard user deletion', () => {
    const offenders: string[] = [];

    for (const file of allSources) {
      const code = codeOf(file);
      if (
        /\bremoveUser\s*\(/.test(code) ||
        code.includes('/admin/remove-user')
      ) {
        offenders.push(relative(file));
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * Hard organization deletion likewise. `disableOrganizationDeletion: true`
   * turns the route off; this asserts nothing tries to call it anyway.
   */
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

  /**
   * No session cache in this build. The database is the source of truth for
   * authentication as well as authorization, so a revoked session, a
   * deactivated account, a role change and a membership removal all take
   * effect on the very next request.
   *
   * Both names are Better Auth configuration keys, and neither has any other
   * meaning in this codebase, so a repository-wide scan is exact.
   */
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

  /**
   * The same rule, aimed at the mechanism rather than at a word.
   *
   * This used to be a repository-wide grep for `ioredis`, which held only for
   * as long as the service had no Redis at all. It now does — as queue
   * transport and ephemeral coordination state — so the grep would forbid the
   * platform module instead of the misuse.
   *
   * What actually has to stay true is narrower and stronger: authentication
   * state never leaves PostgreSQL, and no authentication path enqueues work.
   * Enforced on the auth layer's imports, because handing Better Auth a cache
   * is not something that can be done without reaching for one from here.
   *
   * Matched on *path segments* rather than on a substring of the specifier.
   * The previous form looked for `infrastructure/redis`, which stopped matching
   * the moment those modules moved under `core/` and the sibling import became
   * `../redis` — a check that silently passes after a directory move is worse
   * than no check, because nobody looks at it again.
   */
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

  /**
   * Better Auth owns its own OpenAPI document. Re-describing one of its paths
   * with a Nest decorator would create a second, drifting source of truth.
   */
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
