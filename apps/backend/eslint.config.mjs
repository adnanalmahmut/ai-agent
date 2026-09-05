// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// These selectors inspect TypeScript AST nodes, never source text. Keep the
// ordinary layer restrictions when adding the narrower auth/mail import rules.
const INFRASTRUCTURE_IMPORT_PATTERNS = [
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
];
const SOURCE_EXCLUSIONS = [
  '**/*.spec.ts',
  'src/**/generated/**',
  'src/**/i18n/**',
];
const ROLE_FIELD =
  ":matches(Identifier[name='role'], MemberExpression[property.name='role'], MemberExpression[computed=true][property.value='role'])";
const ROLE_VALUE = `:matches(${ROLE_FIELD}, TSAsExpression:has(> ${ROLE_FIELD}), TSTypeAssertion:has(> ${ROLE_FIELD}), TSNonNullExpression:has(> ${ROLE_FIELD}))`;
const PERMISSION_DECORATOR =
  'Decorator:matches([expression.callee.name=/^(MemberHasPermission|UserHasPermission)$/], [expression.callee.property.name=/^(MemberHasPermission|UserHasPermission)$/])';
const AUTH_CONTROLLER =
  "Decorator > CallExpression:matches([callee.name='Controller'], [callee.property.name='Controller'])";
const AUTHORIZATION_SYNTAX = [
  {
    selector: `BinaryExpression[operator=/^(==|===|!=|!==)$/]:has(> ${ROLE_VALUE}):has(> :matches(Literal[value=/^/], TemplateLiteral))`,
    message:
      'Authorize through permission helpers, not role-string comparisons.',
  },
  {
    selector: `CallExpression[callee.property.name='includes'] > MemberExpression > CallExpression:has(> ${ROLE_VALUE})`,
    message:
      'Authorize through permission helpers, not role-name membership checks.',
  },
  {
    selector:
      ':matches(Decorator[expression.callee.name=/^(Roles|OrgRoles)$/], Decorator[expression.callee.property.name=/^(Roles|OrgRoles)$/], ImportSpecifier[imported.name=/^(Roles|OrgRoles)$/])',
    message: 'Use permission decorators instead of role-name decorators.',
  },
  {
    selector: `:matches(ClassDeclaration, ClassExpression, MethodDefinition):has(> Decorator:matches([expression.name='RequireActiveOrg'], [expression.callee.name='RequireActiveOrg'], [expression.callee.property.name='RequireActiveOrg'])):not(:has(> ${PERMISSION_DECORATOR}))`,
    message:
      'RequireActiveOrg must be paired with a permission decorator on the same class or handler.',
  },
  {
    selector:
      ':matches(CallExpression[callee.name=/^(removeUser|deleteOrganization)$/], MemberExpression[property.name=/^(removeUser|deleteOrganization)$/], MemberExpression[computed=true][property.value=/^(removeUser|deleteOrganization)$/])',
    message:
      'Use account deactivation and organization archival, never Better Auth hard deletion.',
  },
  {
    // Only a key in this guard table is allowed; a call or value inside it is not.
    selector: String.raw`Literal[value=/\u002Fadmin\u002Fremove-user/]:not(VariableDeclarator[id.name='SUPER_ADMIN_GUARDED_PATHS'] > ObjectExpression > Property > Literal.key), TemplateElement[value.cooked=/\u002Fadmin\u002Fremove-user/]`,
    message:
      'The hard user-delete path is permitted only as a SUPER_ADMIN_GUARDED_PATHS key.',
  },
  {
    selector: String.raw`Literal[value=/\u002Forganization\u002Fdelete/], TemplateElement[value.cooked=/\u002Forganization\u002Fdelete/]`,
    message:
      'Use organization archival, never the Better Auth hard-delete route.',
  },
  {
    selector:
      ':matches(Identifier[name=/cookieCache|secondaryStorage/], Literal[value=/cookieCache|secondaryStorage/], TemplateElement[value.cooked=/cookieCache|secondaryStorage/])',
    message:
      'Keep sessions authoritative in PostgreSQL; do not configure cookieCache or secondaryStorage.',
  },
  {
    selector: [
      String.raw`${AUTH_CONTROLLER} > Literal[value=/^\u002F?api\u002Fauth/]`,
      String.raw`${AUTH_CONTROLLER} > TemplateLiteral > TemplateElement[value.cooked=/^\u002F?api\u002Fauth/]`,
      String.raw`${AUTH_CONTROLLER} > ArrayExpression > Literal[value=/^\u002F?api\u002Fauth/]`,
      String.raw`${AUTH_CONTROLLER} > ObjectExpression > Property[key.name='path'] > Literal.value[value=/^\u002F?api\u002Fauth/]`,
    ].join(', '),
    message:
      'Better Auth owns /api/auth; do not mount Nest controllers on its routes.',
  },
];
const ROLE_NAMES_SYNTAX = {
  selector:
    ':matches(Literal[value=/^(super_admin|owner)$/], TemplateLiteral[expressions.length=0] > TemplateElement[value.cooked=/^(super_admin|owner)$/])',
  message:
    'Name roles only in infrastructure/auth/permissions.ts; use the exported policy elsewhere.',
};
const AUTH_IMPORT_PATTERNS = [
  ...INFRASTRUCTURE_IMPORT_PATTERNS,
  {
    regex: '^(resend|nodemailer|@aws-sdk|postmark)',
    message:
      'Auth must not import mail provider SDKs; use the mail module surface.',
  },
  { regex: 'transport', message: 'Auth must not import mail transports.' },
  {
    group: ['nestjs-i18n'],
    message: 'Auth must not read ambient i18n context.',
  },
  {
    regex: '^\\.\\./(?=.*mail)(?!mail$)',
    message: 'Auth reaches mail only through ../mail.',
  },
  {
    regex: '(^|/)(redis|queue|outbox)(/|$)|^(ioredis|bullmq)(/|$)',
    message: 'Auth must not depend on Redis, queues, or outbox.',
  },
];
const MAIL_IMPORT_PATTERNS = [
  ...INFRASTRUCTURE_IMPORT_PATTERNS,
  {
    regex: 'better-auth',
    caseSensitive: true,
    message: 'Mail must not depend on Better Auth.',
  },
  {
    group: ['nestjs-i18n'],
    message: 'Mail must not read ambient i18n context.',
  },
];
const MAIL_PROVIDER_PATTERN = {
  regex: '^(resend|nodemailer|@aws-sdk|postmark|sendgrid)',
  message:
    'Only mail transports and notification delivery adapters may import provider SDKs.',
};

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
      'no-restricted-properties': [
        'error',
        {
          property: 'createUser',
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
          patterns: INFRASTRUCTURE_IMPORT_PATTERNS,
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
  {
    files: ['src/**/*.ts'],
    ignores: SOURCE_EXCLUSIONS,
    rules: { 'no-restricted-syntax': ['error', ...AUTHORIZATION_SYNTAX] },
  },
  {
    files: ['src/**/*.ts'],
    ignores: [...SOURCE_EXCLUSIONS, 'src/infrastructure/auth/permissions.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...AUTHORIZATION_SYNTAX,
        ROLE_NAMES_SYNTAX,
      ],
    },
  },
  {
    files: ['src/infrastructure/auth/**/*.ts'],
    ignores: SOURCE_EXCLUSIONS,
    rules: {
      'no-restricted-imports': ['error', { patterns: AUTH_IMPORT_PATTERNS }],
    },
  },
  {
    files: ['src/infrastructure/mail/**/*.ts'],
    ignores: SOURCE_EXCLUSIONS,
    rules: {
      'no-restricted-imports': ['error', { patterns: MAIL_IMPORT_PATTERNS }],
    },
  },
  {
    files: ['src/infrastructure/mail/**/*.ts'],
    ignores: [
      ...SOURCE_EXCLUSIONS,
      '**/*-mail.transport.ts',
      '**/*-notification.delivery.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...MAIL_IMPORT_PATTERNS, MAIL_PROVIDER_PATTERN] },
      ],
    },
  },
  {
    files: ['src/infrastructure/mail/mail.service.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...MAIL_IMPORT_PATTERNS,
            MAIL_PROVIDER_PATTERN,
            {
              regex: '\\.transport(?:\\.[cm]?[jt]s)?$',
              message:
                'MailService depends on the transport abstraction, not concrete transports.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/infrastructure/mail/index.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...MAIL_IMPORT_PATTERNS,
            MAIL_PROVIDER_PATTERN,
            {
              group: ['./*'],
              importNames: ['MAIL_TRANSPORT', 'MailTransport', 'OutboundMail'],
              message:
                'Keep mail transport internals out of the public module surface.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...AUTHORIZATION_SYNTAX,
        ROLE_NAMES_SYNTAX,
        {
          selector:
            ":matches(ExportSpecifier[local.name=/^(MAIL_TRANSPORT|MailTransport|OutboundMail)$/], ExportSpecifier[exported.name=/^(MAIL_TRANSPORT|MailTransport|OutboundMail)$/], ExportNamedDeclaration > :matches(TSInterfaceDeclaration, TSTypeAliasDeclaration)[id.name=/^(MailTransport|OutboundMail)$/], ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.name='MAIL_TRANSPORT'])",
          message:
            'Keep mail transport internals out of the public module surface.',
        },
      ],
    },
  },
);
