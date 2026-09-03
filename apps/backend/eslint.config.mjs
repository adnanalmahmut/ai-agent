// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs', 'src/generated/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
  {
    files: ['test/**/*.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
  // In-process Better Auth createUser bypasses request authorization; only the
  // bootstrap CLI may use it before a session exists.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/cli/**', '**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='createUser']",
          message:
            'Better Auth createUser bypasses authorization when called in-process. It is permitted only from the CLI bootstrap composition root (src/cli/**).',
        },
      ],
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/infrastructure/**',
                '**/ai/**',
                '**/features/**',
                '**/api/**',
                '**/workers/**',
                '**/cli/**',
              ],
              message:
                'Core must remain independent of infrastructure, AI, product features, and composition roots.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/infrastructure/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/ai/**',
                '**/features/**',
                '**/api/**',
                '**/workers/**',
                '**/cli/**',
              ],
              message:
                'Infrastructure must not depend on AI, product features, or composition roots.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/ai/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/features/**',
                '**/api/**',
                '**/workers/**',
                '**/cli/**',
              ],
              message:
                'Generic AI code must not depend on product features or composition roots.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/features/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/api/**', '**/workers/**', '**/cli/**'],
              message:
                'Product features must not depend on process composition roots.',
            },
          ],
        },
      ],
    },
  },
);
