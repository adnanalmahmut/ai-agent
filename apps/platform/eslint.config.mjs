import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

/**
 * Architectural boundaries are expressed here, as lint rules over the parsed
 * syntax tree, rather than as source-text assertions in a test. The rules
 * below cover only constraints with a concrete failure behind them: an
 * unmediated network call, the server auth SDK reaching the browser bundle, a
 * second mount path, an irreversible delete, or an untranslatable string.
 *
 * Everything they apply to is product code. Test files and Playwright
 * fixtures stand outside these boundaries on purpose, because their job is to
 * stub and drive them.
 */
const APPLICATION_SOURCE = ['src/**/*.ts', 'src/**/*.tsx'];
const NOT_APPLICATION_SOURCE = [
  'src/**/*.test.ts',
  'src/**/*.test.tsx',
  'src/test/**',
];

/** The only two modules that may reach the network directly. */
const API_BOUNDARIES = [
  'src/lib/application-api.ts',
  'src/lib/api/server-request.ts',
];

/** The only module that may construct the Better Auth browser client. */
const AUTH_CLIENT = 'src/features/auth/auth-client.ts';

/** The single declaration of the mount path and the API prefix. */
const PATH_CONSTANTS = 'src/config/paths.ts';

const BETTER_AUTH_SERVER_ENTRY = {
  name: 'better-auth',
  message:
    "The Better Auth server entry belongs to the backend. Use '@/features/auth/auth-client' in the browser or '@/features/auth/server-session' on the server.",
};

const MOUNT_PATH = String.raw`^\/(platform|api)(?:\/|$)`;

const MOUNT_PATH_MESSAGE =
  "Import PLATFORM_BASE_PATH or API_BASE_PATH from '@/config/paths' rather than repeating the mount path.";

/**
 * Attributes a person reads or hears, so they have to come from a message. An
 * empty value stays legal: `alt=""` is how a decorative image is marked.
 */
const READABLE_ATTRIBUTES = String.raw`^(aria-label|aria-description|placeholder|title|alt)$`;

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'dist/**',
    'coverage/**',
    'next-env.d.ts',
  ]),
  {
    files: ['**/*.{ts,tsx,mts}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },

  {
    name: 'platform/architecture-boundaries',
    files: APPLICATION_SOURCE,
    ignores: NOT_APPLICATION_SOURCE,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            BETTER_AUTH_SERVER_ENTRY,
            {
              name: 'better-auth/react',
              message: `Create the Better Auth client only in ${AUTH_CLIENT}, so every caller shares one instance and one plugin configuration.`,
            },
          ],
        },
      ],

      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            "Request through '@/lib/application-api' in the browser or '@/lib/api/server-request' on the server, so error mapping, credentials and the API prefix stay in one place.",
        },
      ],

      'no-restricted-syntax': [
        'error',
        {
          selector: `Literal[value=/${MOUNT_PATH}/]`,
          message: MOUNT_PATH_MESSAGE,
        },
        {
          selector: `TemplateElement[value.cooked=/${MOUNT_PATH}/]`,
          message: MOUNT_PATH_MESSAGE,
        },
        {
          selector:
            'CallExpression[callee.property.name="removeUser"][callee.object.property.name="admin"]',
          message:
            'An account is deactivated and restored, never hard-deleted. Use the account lifecycle API.',
        },
        {
          selector:
            'CallExpression[callee.property.name="delete"][callee.object.property.name="organization"]',
          message:
            'An organization is archived and restored, never hard-deleted. Use the organization lifecycle API.',
        },
        {
          selector: `JSXAttribute[name.name=/${READABLE_ATTRIBUTES}/] > Literal[value=/[A-Za-z]{2}/]`,
          message:
            'A person reads this attribute, so it has to come from a translated message rather than a literal.',
        },
      ],

      // Replaces a hand-written JSX text scanner: same guarantee, read off the
      // syntax tree instead of the source string.
      'react/jsx-no-literals': [
        'error',
        { noStrings: true, ignoreProps: true, allowedStrings: ['·', '→', 'K'] },
      ],
    },
  },

  {
    name: 'platform/api-boundary-modules',
    files: API_BOUNDARIES,
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    name: 'platform/auth-client-module',
    files: [AUTH_CLIENT],
    rules: {
      'no-restricted-imports': ['error', { paths: [BETTER_AUTH_SERVER_ENTRY] }],
    },
  },
  {
    name: 'platform/path-constants',
    files: [PATH_CONSTANTS],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // A developer-facing showcase of the design tokens: the class names and
    // token names it prints are the subject matter, not user-facing copy.
    name: 'platform/design-system-showcase',
    files: ['src/features/design-system/**'],
    rules: { 'react/jsx-no-literals': 'off' },
  },
]);
