import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

/**
 * The boundaries this surface has to keep, expressed as rules over the parsed
 * syntax tree rather than as source-text assertions.
 *
 * Three of them matter here: the Better Auth server entry belongs to the
 * backend and may not be constructed in a browser bundle; nothing reaches the
 * network except through the shared transport, so the request path stays in
 * one place; and a person never reads a literal, because an administrative
 * surface is bilingual from its first screen.
 *
 * The customer application enforces a fourth — no repeated mount path — which
 * has no counterpart here: this application has no base path to repeat.
 */
const APPLICATION_SOURCE = ['src/**/*.ts', 'src/**/*.tsx'];
const NOT_APPLICATION_SOURCE = [
  'src/**/*.test.ts',
  'src/**/*.test.tsx',
  'src/test/**',
];

/** The only module that may construct the Better Auth browser client. */
const AUTH_CLIENT = 'src/features/auth/auth-client.ts';

const BETTER_AUTH_SERVER_ENTRY = {
  name: 'better-auth',
  message:
    "The Better Auth server entry belongs to the backend. Use '@/features/auth/auth-client' in the browser or '@/features/auth/server-session' on the server.",
};

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
    name: 'admin/architecture-boundaries',
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
          patterns: [
            {
              // The whole point of a separate workspace is that it does not
              // depend on the customer application's internals.
              group: ['**/apps/app/**', '../../app/**', '../app/**'],
              message:
                'The admin surface may not import the customer application. Share through a package instead.',
            },
          ],
        },
      ],

      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            "Request through '@/lib/api/server-request' on the server, so error mapping, credentials and the API prefix stay in one place.",
        },
      ],

      'no-restricted-syntax': [
        'error',
        {
          selector: `JSXAttribute[name.name=/${READABLE_ATTRIBUTES}/] > Literal[value=/[A-Za-z]{2}/]`,
          message:
            'A person reads this attribute, so it has to come from a translated message rather than a literal.',
        },
      ],

      'react/jsx-no-literals': ['error', { noStrings: true, ignoreProps: true }],
    },
  },

  {
    name: 'admin/auth-client-module',
    files: [AUTH_CLIENT],
    rules: {
      'no-restricted-imports': ['error', { paths: [BETTER_AUTH_SERVER_ENTRY] }],
    },
  },
]);
