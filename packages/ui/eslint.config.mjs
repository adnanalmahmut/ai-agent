import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['dist/**']),
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat['recommended-latest'],
    ],
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
]);
