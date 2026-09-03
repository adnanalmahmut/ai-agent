import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

const DESIGN_SYSTEM_PAGE = join(
  'features',
  'design-system',
  'design-system-page.tsx',
);

const OWNED_DIRECTORIES = [
  join('src', 'app'),
  join('src', 'features'),
  join('src', 'i18n'),
  join('src', 'lib'),
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

const SOURCE_FILES = ALL_FILES.filter(
  (path) => !isTest(path) && !isTestSupport(path) && !isDesignSystemPage(path),
);

const OWNED_FILES = SOURCE_FILES.filter((path) =>
  OWNED_DIRECTORIES.some((directory) =>
    relative(process.cwd(), path).startsWith(directory),
  ),
);

const read = (path: string) => readFileSync(path, 'utf8');
const label = (path: string) => relative(process.cwd(), path);

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('Next.js boundaries are explicit', () => {
  it('declares the framework packages directly', () => {
    const manifest: {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    } = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));

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

  it('does not retain the legacy router package or source imports', () => {
    const manifest: {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    } = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));

    expect({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    }).not.toHaveProperty('react-router');

    for (const path of ALL_FILES) {
      expect(read(path), label(path)).not.toMatch(/from ['"]react-router/);
    }
  });

  it('does not retain the legacy SPA toolchain or static runtime', () => {
    const manifest: {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    } = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const installed = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };

    expect(installed).not.toHaveProperty('vite');
    expect(installed).not.toHaveProperty('@vitejs/plugin-react');
    expect(installed).not.toHaveProperty('@tailwindcss/vite');

    for (const obsoletePath of ['index.html', 'vite.config.ts', 'nginx.conf']) {
      expect(() => statSync(join(process.cwd(), obsoletePath))).toThrow();
    }
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
    expect(pages.length).toBeGreaterThan(20);
  });

  it.each(pages.map((path) => [label(path), path]))(
    '%s composes rather than implements',
    (_name, path) => {
      const source = withoutComments(read(path));

      expect(source.split('\n').length).toBeLessThan(100);

      expect(source).not.toMatch(/\buseState\b/);
      expect(source).not.toMatch(/\buseEffect\b/);
      expect(source).not.toMatch(/<form\b/);
      expect(source).not.toMatch(/onClick=/);
    },
  );

  it('never lets a route talk to Better Auth directly', () => {
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
    const offenders = SOURCE_FILES.filter((path) =>
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
    const offenders = SOURCE_FILES.filter((path) =>
      /if\s*\(\s*[\w.?]*activeOrganizationId\s*\)/.test(
        withoutComments(read(path)),
      ),
    ).map(label);

    expect(offenders).toEqual([]);
  });

  it('offers no hard delete for a user or an organization', () => {
    for (const path of SOURCE_FILES) {
      const source = withoutComments(read(path));

      expect(source, label(path)).not.toMatch(/organization\.delete\s*\(/);
      expect(source, label(path)).not.toMatch(/admin\.removeUser\s*\(/);
    }
  });
});

describe('the design system is consumed, not re-created', () => {
  it('has files to check', () => {
    expect(OWNED_FILES.length).toBeGreaterThan(40);
  });

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
    const offenders = SOURCE_FILES.filter((path) =>
      /dir=["'](rtl|ltr)["']/.test(withoutComments(read(path))),
    ).map(label);

    expect(offenders).toEqual([]);
  });

  it('branches on a locale name nowhere', () => {
    const offenders = SOURCE_FILES.filter((path) =>
      /locale\s*[=!]==?\s*['"](ar|en)['"]/.test(withoutComments(read(path))),
    ).map(label);

    expect(offenders).toEqual([]);
  });
});

describe('no user-facing string is hard-coded', () => {
  const FEATURE_DIRECTORIES = [
    join('src', 'features'),
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
    expect(jsxLiterals('<p>Sign in to continue</p>')).toEqual([
      'Sign in to continue',
    ]);
    expect(jsxLiterals("<p>{t('signIn.title')}</p>")).toEqual([]);
  });

  it('renders no literal text between JSX tags', () => {
    for (const path of componentFiles) {
      const source = withoutComments(read(path));

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
