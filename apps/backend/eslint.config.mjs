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
  /**
   * `createUser` is reachable without authorization, and only the CLI may use
   * it.
   *
   * Verified against better-auth 1.6.27: the admin plugin's `createUser` route
   * skips the `user:create`, `user:set-role` and `user:ban` permission checks
   * entirely when invoked with neither a request nor headers — the in-process
   * form. That is precisely what makes it usable for first-run bootstrap, when
   * no session can exist, and precisely what makes it dangerous anywhere else:
   * a request-handling service that called it without forwarding headers would
   * mint a super administrator with no authorization at all, silently.
   *
   * The CLI composition root is the only place that provides it, so today the
   * boundary holds by wiring. This makes it hold by rule, because `AuthService`
   * is injectable throughout `AppModule` and the pattern is now documented.
   */
  {
    files: ['src/**/*.ts'],
    ignores: ['src/cli/**', 'src/cli.ts', '**/*.spec.ts'],
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
);
