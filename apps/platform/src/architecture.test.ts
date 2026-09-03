import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Executable architecture rules.
 *
 * Every constraint below is one a reviewer would otherwise have to remember on
 * every pull request: thin routes, no scattered fetches, no role strings in
 * components, no magic colours, logical spacing, and explicit Next.js
 * boundaries. Written as tests because a rule that is only in a
 * document is a rule that decays.
 *
 * Each exemption names a file and says why. An exemption list that grows
 * without reasons is how these rules die quietly.
 */

const SRC = join(process.cwd(), 'src');

/** The showcase predates this work and is a reference, not a page. */
const DESIGN_SYSTEM_PAGE = join('routes', 'dashboard', 'design-system-page.tsx');

/**
 * Code this migration owns.
 *
 * The visual rules below are scoped to it rather than to all of `src`. The
 * showcase, the language switcher and the theme toggle predate this work and
 * were not in its brief; policing them here would either force unrelated edits
 * or produce an exemption list long enough to make the rule meaningless.
 */
const OWNED_DIRECTORIES = [
  join('src', 'app'),
  join('src', 'features'),
  join('src', 'i18n'),
  join('src', 'lib'),
  join('src', 'routes'),
  join('src', 'components', 'brand-mark.tsx'),
  join('src', 'components', 'confirm-dialog.tsx'),
  join('src', 'components', 'directional-icon.ts'),
  join('src', 'components', 'empty-state.tsx'),
  join('src', 'components', 'page-header.tsx'),
  join('src', 'components', 'person-identity.tsx'),
];

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);

    if (statSync(path).isDirectory()) return walk(path);

    return /\.tsx?$/.test(path) ? [path] : [];
  });
}

const ALL_FILES = walk(SRC);

const isTest = (path: string) => /\.test\.tsx?$/.test(path);
const isTestSupport = (path: string) => path.includes(`${sep}test${sep}`);
const isDesignSystemPage = (path: string) => path.includes(DESIGN_SYSTEM_PAGE);

/** Application source: excludes tests, their helpers and the showcase. */
const SOURCE_FILES = ALL_FILES.filter(
  (path) => !isTest(path) && !isTestSupport(path) && !isDesignSystemPage(path),
);

/** The subset of application source this migration is responsible for. */
const OWNED_FILES = SOURCE_FILES.filter((path) =>
  OWNED_DIRECTORIES.some((directory) =>
    relative(process.cwd(), path).startsWith(directory),
  ),
);

const read = (path: string) => readFileSync(path, 'utf8');
const label = (path: string) => relative(process.cwd(), path);

/** Strips comments so prose about a rule does not trip the rule. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('Next.js boundaries are explicit', () => {
  it('declares the framework packages directly', () => {
    const manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } =
      JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));

    const installed = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    });

    expect(installed).toEqual(
      expect.arrayContaining([
        'next',
        'next-intl',
        'server-only',
        'eslint-config-next',
      ]),
    );
  });

  it('keeps server-only imports out of client modules', () => {
    const clientFiles = SOURCE_FILES.filter((path) =>
      /^['"]use client['"];/.test(read(path)),
    );

    for (const path of clientFiles) {
      expect(read(path), label(path)).not.toMatch(/['"]server-only['"]/);
    }
  });
});

describe('routes stay thin', () => {
  const ROUTE_FILES = SOURCE_FILES.filter((path) =>
    relative(process.cwd(), path).startsWith(join('src', 'app')),
  );
  const pages = ROUTE_FILES.filter((path) => path.endsWith(`${sep}page.tsx`));

  it('finds the routes it is meant to be checking', () => {
    // A refactor that moved the routes directory must not silently disarm
    // this into a test that passes because it looks at nothing.
    expect(pages.length).toBeGreaterThan(20);
  });

  it.each(pages.map((path) => [label(path), path]))(
    '%s composes rather than implements',
    (_name, path) => {
      const source = withoutComments(read(path));

      // A route may read its loader data, read the query string, and render a
      // block. Anything longer is a page that has grown a feature inside it.
      // The budget grew from 90 to 100 when the organization gained its ninth
      // tab: one export per tab is composition, and the four assertions below
      // are what actually catch a feature growing in here.
      expect(source.split('\n').length).toBeLessThan(100);

      expect(source).not.toMatch(/\buseState\b/);
      expect(source).not.toMatch(/\buseEffect\b/);
      expect(source).not.toMatch(/<form\b/);
      expect(source).not.toMatch(/onClick=/);
    },
  );

  it('never lets a route talk to Better Auth directly', () => {
    // Routes reach the protocol through the auth feature, so there is one
    // place to change when the protocol does.
    for (const path of ROUTE_FILES) {
      expect(read(path), label(path)).not.toMatch(/from ['"]better-auth/);
    }
  });
});

describe('no scattered network calls', () => {
  const API_BOUNDARIES = [
    join('src', 'lib', 'api', 'server-request.ts'),
    join('src', 'lib', 'application-api.ts'),
  ];

  it('calls fetch only from the server and browser API boundaries', () => {
    const callers = SOURCE_FILES.filter((path) =>
      /(^|[^.\w])fetch\s*\(/m.test(withoutComments(read(path))),
    ).map(label);

    expect(callers).toEqual(API_BOUNDARIES);
  });

  it('imports the Better Auth client from exactly one module', () => {
    const creators = SOURCE_FILES.filter((path) =>
      read(path).includes('createAuthClient'),
    );

    // One instance: the client owns a session atom and a cross-tab broadcast
    // channel, and a second would mean two of each, quietly disagreeing.
    expect(creators.map(label)).toEqual(['src/features/auth/auth-client.ts']);
  });

  it('never imports the Better Auth server entry into the application', () => {
    for (const path of SOURCE_FILES) {
      expect(read(path), label(path)).not.toMatch(/from ['"]better-auth['"]/);
    }
  });
});

describe('authentication is a router boundary, not an effect', () => {
  it('protects nothing with a redirect inside useEffect', () => {
    // The failure this prevents is specific: an effect runs *after* the
    // component rendered, so a private page guarded that way has already
    // painted — and already asked for data — before it discovers there is no
    // session.
    const offenders = SOURCE_FILES.filter((path) => {
      const source = withoutComments(read(path));

      return /useEffect\([\s\S]{0,400}?(navigate|redirect)\s*\(/.test(source);
    }).map(label);

    expect(offenders).toEqual([]);
  });

  it('guards the private tree in its server layout', () => {
    const layout = read(
      join(SRC, 'app', '[locale]', '(platform)', 'layout.tsx'),
    );

    expect(layout).toContain('getServerSession()');
    expect(layout).toContain('if (!session)');
    expect(layout.indexOf('if (!session)')).toBeLessThan(
      layout.indexOf('<PlatformShell'),
    );
    expect(layout).toContain('returnPathFromUrl');
  });
});

describe('the mount point is stated once', () => {
  it('is read from the path constant by Next configuration', () => {
    const config = read(join(process.cwd(), 'next.config.ts'));

    expect(config).toContain('import { PLATFORM_BASE_PATH }');
    expect(config).toContain('basePath: PLATFORM_BASE_PATH');
  });

  it('hard-codes the platform or api path nowhere else', () => {
    const offenders = SOURCE_FILES.filter(
      (path) =>
        !path.endsWith(join('config', 'paths.ts')) &&
        /['"`]\/(platform|api)\//.test(withoutComments(read(path))),
    ).map(label);

    expect(offenders).toEqual([]);
  });
});

describe('authorization is asked about permissions, not roles', () => {
  const ROLE_DEFINITIONS = join('features', 'authorization', 'permissions.ts');

  it('compares a role name nowhere in the application', () => {
    // `role === 'admin'` scattered through components is what makes a
    // permission change a search-and-replace. The gates ask "may this?".
    const offenders = SOURCE_FILES.filter((path) =>
      // `typeof role === 'string'` is a shape check before handing the value
      // to the evaluator, not a decision about what the role means.
      /(?<!typeof\s)\brole\w*\s*[=!]==?\s*['"]/.test(
        withoutComments(read(path)),
      ),
    ).map(label);

    expect(offenders).toEqual([]);
  });

  it('names a role only where roles are defined', () => {
    const names = /'(super_admin|owner|member)'/;

    const offenders = SOURCE_FILES.filter(
      (path) =>
        !path.includes(ROLE_DEFINITIONS) &&
        names.test(withoutComments(read(path))),
    ).map(label);

    expect(offenders).toEqual([]);
  });

  it('treats an active organization as context, never as access', () => {
    // The backend's invariant, mirrored: no component may gate on the mere
    // presence of an active organization.
    const offenders = SOURCE_FILES.filter((path) =>
      /if\s*\(\s*[\w.?]*activeOrganizationId\s*\)/.test(
        withoutComments(read(path)),
      ),
    ).map(label);

    expect(offenders).toEqual([]);
  });

  it('offers no hard delete for a user or an organization', () => {
    // Both are absent from the backend by two independent mechanisms. A call
    // site here would be a button that can only ever produce a 404.
    for (const path of SOURCE_FILES) {
      const source = withoutComments(read(path));

      expect(source, label(path)).not.toMatch(/organization\.delete\s*\(/);
      expect(source, label(path)).not.toMatch(/admin\.removeUser\s*\(/);
    }
  });
});

describe('the design system is consumed, not re-created', () => {
  it('has files to check', () => {
    // A path change that emptied this list would turn every rule below into
    // a test that passes because it looks at nothing.
    expect(OWNED_FILES.length).toBeGreaterThan(40);
  });

  /** Google's mark is a trademark; its colours are the identity, not a theme. */
  const BRAND_ASSET = join(
    'features',
    'auth',
    'components',
    'google-auth-button.tsx',
  );

  const styled = OWNED_FILES.filter(
    (path) => path.endsWith('.tsx') && !path.includes(BRAND_ASSET),
  );

  it('hard-codes no colour value', () => {
    for (const path of styled) {
      const source = withoutComments(read(path));

      expect(source, label(path)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(source, label(path)).not.toMatch(/\b(rgba?|hsla?|oklch)\(/);
    }
  });

  it('uses no arbitrary Tailwind value for colour, spacing or radius', () => {
    for (const path of styled) {
      const source = withoutComments(read(path));

      expect(source, label(path)).not.toMatch(
        /\b(bg|text|border|shadow|rounded|p|m|w|h)-\[/,
      );
    }
  });

  it('redefines no primitive the package already ships', () => {
    // Duplicating Button or Card is how a second visual language starts.
    const duplicates = SOURCE_FILES.filter((path) =>
      /export function (Button|Input|Card|Badge|Avatar|Skeleton|Separator|Alert|Label|Table|Dialog|Sheet|Sidebar|Select|Tabs|Tooltip)\b/.test(
        read(path),
      ),
    ).map(label);

    expect(duplicates).toEqual([]);
  });
});

describe('direction is handled logically', () => {
  const layoutFiles = OWNED_FILES.filter((path) => path.endsWith('.tsx'));

  it('uses logical spacing rather than physical', () => {
    // `ms`/`me`/`ps`/`pe`/`start`/`end` mirror for free; `ml`/`mr` do not.
    for (const path of layoutFiles) {
      const source = withoutComments(read(path));

      expect(source, label(path)).not.toMatch(
        /\bclassName="[^"]*\b(ml|mr|pl|pr)-\d/,
      );
      expect(source, label(path)).not.toMatch(
        /\bclassName="[^"]*\b(left|right)-\d/,
      );
      expect(source, label(path)).not.toMatch(
        /\bclassName="[^"]*\btext-(left|right)\b/,
      );
    }
  });

  it('writes a literal direction nowhere', () => {
    // Direction comes from `LOCALE_META`. The locale route assigns it to the
    // document element; nothing else states one.
    const offenders = SOURCE_FILES.filter((path) =>
      /dir=["'](rtl|ltr)["']/.test(withoutComments(read(path))),
    ).map(label);

    expect(offenders).toEqual([]);
  });

  it('branches on a locale name nowhere', () => {
    // A `locale === 'ar'` in a component is a rule that a third locale would
    // silently break.
    const offenders = SOURCE_FILES.filter((path) =>
      /locale\s*[=!]==?\s*['"](ar|en)['"]/.test(withoutComments(read(path))),
    ).map(label);

    expect(offenders).toEqual([]);
  });
});

describe('no user-facing string is hard-coded', () => {
  const FEATURE_DIRECTORIES = [
    join('src', 'features'),
    join('src', 'routes'),
    join('src', 'components'),
  ];

  const componentFiles = SOURCE_FILES.filter(
    (path) =>
      path.endsWith('.tsx') &&
      FEATURE_DIRECTORIES.some((directory) =>
        label(path).startsWith(directory),
      ),
  );

  it('finds the components it is meant to be checking', () => {
    expect(componentFiles.length).toBeGreaterThan(25);
  });

  const jsxLiterals = (source: string) =>
    [...source.matchAll(/>\s*([A-Za-z][^<>{}]*[A-Za-z])\s*</g)]
      .map((match) => match[1] as string)
      .filter((text) => /[A-Za-z]{2,}/.test(text));

  it('has a detector that actually detects', () => {
    // Without this, a regex that stopped matching would read as every file
    // being clean.
    expect(jsxLiterals('<p>Sign in to continue</p>')).toEqual([
      'Sign in to continue',
    ]);
    expect(jsxLiterals("<p>{t('signIn.title')}</p>")).toEqual([]);
  });

  it('renders no literal text between JSX tags', () => {
    for (const path of componentFiles) {
      const source = withoutComments(read(path));

      // Anything that came from `t(...)` sits inside braces and is skipped by
      // the character class; what is left is a literal a translator will
      // never see.
      expect(jsxLiterals(source), label(path)).toEqual([]);
    }
  });

  it('passes no literal to an attribute a user can read', () => {
    for (const path of componentFiles) {
      const source = withoutComments(read(path));

      expect(source, label(path)).not.toMatch(
        /\s(aria-label|placeholder|title|alt)="[^"]*[A-Za-z]{2}/,
      );
    }
  });
});
