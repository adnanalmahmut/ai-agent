import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

/**
 * Lint rules for a React + Vite application.
 *
 * `eslint-config-next` went with Next.js — it encoded rules about `next/image`,
 * `next/link` and the `pages` directory that describe a framework this app no
 * longer uses. What it was genuinely buying us was the React Hooks rules and
 * TypeScript awareness, and both are here directly.
 */
export default defineConfig([
  globalIgnores(['dist/**', 'coverage/**']),

  {
    files: ['**/*.{ts,tsx,mts}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      // `configs.flat` is the flat-config namespace; the top-level
      // `recommended-latest` is still the eslintrc shape and ESLint 9 rejects it.
      reactHooks.configs.flat['recommended-latest'],
    ],
    rules: {
      // The rule of hooks is not advisory here: the auth and organization
      // hooks are the whole state layer, and a conditional call would produce
      // a bug that only appears on an error path.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // `any` is banned by the brief; this is the mechanical half of that.
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },

  // Fast Refresh needs a module to export components and nothing else. Route
  // modules deliberately export loaders alongside their component, which is
  // the documented React Router shape, so they are exempt.
  {
    files: ['src/**/*.tsx'],
    // Excluded because each of these legitimately exports something that is
    // not a component: route modules export loaders beside their element,
    // the navigation module exports hooks beside `Link`, and the test
    // helpers are never hot-reloaded at all.
    ignores: ['src/routes/**', 'src/app/**', 'src/i18n/**', 'src/test/**'],
    plugins: { 'react-refresh': reactRefresh },
    rules: {
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },

  {
    files: ['vite.config.ts', 'vitest.config.mts', 'vitest.setup.ts'],
    languageOptions: { globals: globals.node },
  },
]);
