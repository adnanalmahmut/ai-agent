import { describe, expect, it } from '@jest/globals';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

// Load the real configuration, including file-scoped overrides. Fixtures need
// parsing, not a TypeScript project or unrelated type-aware lint diagnostics.
const eslint = new ESLint({
  cwd: process.cwd(),
  overrideConfig: [tseslint.configs.disableTypeChecked],
});
const AUTH = 'src/infrastructure/auth/fixture.ts';
const MAIL = 'src/infrastructure/mail/fixture.ts';
const SERVICE = 'src/infrastructure/mail/mail.service.ts';
const SURFACE = 'src/infrastructure/mail/index.ts';
const FEATURE = 'src/features/fixture.ts';
const RESTRICTIONS = new Set([
  'no-restricted-imports',
  'no-restricted-syntax',
  'no-restricted-properties',
]);

async function restrictions(code: string, filePath = FEATURE) {
  const [result] = await eslint.lintText(code, { filePath });
  expect(result.fatalErrorCount).toBe(0);
  return result.messages.filter((message) =>
    RESTRICTIONS.has(message.ruleId ?? ''),
  );
}

const importForms = [
  (name: string) => `import { Client } from '${name}';`,
  (name: string) => `import { Client as Renamed } from "${name}";`,
  (name: string) => `import /* comment */ {\n Client,\n} from\n "${name}";`,
  (name: string) => `import type { Client } from "${name}";`,
  (name: string) => `import { type Client } from "${name}";`,
  (name: string) => `import * as sdk from "${name}";`,
  (name: string) => `import "${name}";`,
  (name: string) => `export { Client as Renamed } from "${name}";`,
  (name: string) => `export * from "${name}";`,
  (name: string) => `import sdk = require("${name}");`,
];

describe('auth/mail imports through the Backend ESLint configuration', () => {
  it.each([
    'resend',
    'nodemailer/lib/smtp-transport',
    '@aws-sdk/client-sesv2',
    'postmark',
    '../mail/mail-transport',
    '../mail/SMTP.TRANSPORT',
    'nestjs-i18n',
    '../mail/mail.service',
    'ioredis',
    'bullmq',
    '../redis',
    '../queue/queue.module',
    '../outbox',
  ])('rejects auth import syntax variations for %s', async (specifier) => {
    for (const form of importForms) {
      const messages = await restrictions(form(specifier), AUTH);
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'no-restricted-imports',
            severity: 2,
          }),
        ]),
      );
    }
  });

  it.each(['../mail', './permissions', '@nestjs/common'])(
    'accepts auth import syntax variations for %s',
    async (specifier) => {
      for (const form of importForms)
        expect(await restrictions(form(specifier), AUTH)).toEqual([]);
    },
  );

  it.each([
    'better-auth',
    '@thallesp/nestjs-better-auth',
    'nestjs-i18n',
    'resend',
    'nodemailer',
    '@aws-sdk/client-sesv2',
    'postmark',
    'sendgrid',
  ])('rejects mail import syntax variations for %s', async (specifier) => {
    for (const form of importForms)
      expect(await restrictions(form(specifier), MAIL)).not.toEqual([]);
  });

  it.each([
    'src/infrastructure/mail/resend-mail.transport.ts',
    'src/infrastructure/mail/resend-notification.delivery.ts',
  ])('allows provider imports only in adapters: %s', async (file) => {
    for (const form of importForms) {
      expect(await restrictions(form('resend'), file)).toEqual([]);
      expect(await restrictions(form('better-auth'), file)).not.toEqual([]);
      expect(await restrictions(form('nestjs-i18n'), file)).not.toEqual([]);
    }
  });

  it('keeps MailService on its abstraction', async () => {
    for (const form of importForms) {
      expect(await restrictions(form('./mail-transport'), SERVICE)).toEqual([]);
      expect(
        await restrictions(form('./smtp-mail.transport'), SERVICE),
      ).not.toEqual([]);
      expect(
        await restrictions(form('./smtp-mail.transport.js'), SERVICE),
      ).not.toEqual([]);
    }
  });

  it.each([
    AUTH,
    MAIL,
    SERVICE,
    SURFACE,
    'src/infrastructure/mail/ses-mail.transport.ts',
  ])('preserves infrastructure layer restrictions in %s', async (file) => {
    expect(
      await restrictions(
        'import { Feature } from "../../features/feature";',
        file,
      ),
    ).not.toEqual([]);
    const queueImport = await restrictions(
      'import { Queue } from "../queue";',
      file,
    );
    if (file === AUTH) expect(queueImport).not.toEqual([]);
    else expect(queueImport).toEqual([]);
  });

  it('preserves the other layer restrictions', async () => {
    for (const file of ['src/core/fixture.ts', 'src/ai/fixture.ts', FEATURE]) {
      expect(
        await restrictions(
          'import { ApiModule } from "../api/api.module";',
          file,
        ),
      ).not.toEqual([]);
    }
  });

  it.each([
    'export { MAIL_TRANSPORT } from "./mail-transport";',
    'export { MAIL_TRANSPORT as PublicTransport } from "./mail-transport";',
    'export type { MailTransport as PublicTransport } from "./mail-transport";',
    'export { type OutboundMail } from "./mail.types";',
    'export * from "./mail-transport";',
    'export * as internals from "./mail-transport";',
    'const token = Symbol(); export { token as MAIL_TRANSPORT };',
    'const MAIL_TRANSPORT = Symbol(); export { MAIL_TRANSPORT as token };',
    'export interface MailTransport {}',
    'export type OutboundMail = {};',
    'export const MAIL_TRANSPORT = Symbol();',
  ])('keeps private mail exports out of the barrel: %s', async (code) => {
    expect(await restrictions(code, SURFACE)).not.toEqual([]);
  });

  it.each([
    'export { MailService } from "./mail.service";',
    'export { MailDeliveryError } from "./mail-transport";',
    'export type { MailJob } from "./mail.types";',
  ])('allows public mail exports: %s', async (code) => {
    expect(await restrictions(code, SURFACE)).toEqual([]);
  });
});

describe('authorization syntax through the Backend ESLint configuration', () => {
  it.each([
    "role === 'admin'",
    "user.role != 'admin'",
    "'admin' === user.role",
    'user["role"] !== `admin`',
    '(user.role as string) == "admin"',
    'user.role! === "admin"',
    'role === ""',
    'parseRoles(role).includes("admin")',
    'parseRoles(user.role).includes("admin")',
    'const role = "super_admin";',
    'const role = `owner`;',
    '@Roles("admin") class Controller {}',
    '@auth.OrgRoles("admin") class Controller {}',
    'import { Roles as Access } from "@thallesp/nestjs-better-auth";',
    'auth.api.removeUser({});',
    'auth.api["removeUser"]({});',
    'auth.api?.deleteOrganization({});',
    'removeUser({});',
    'request("/admin/remove-user");',
    'request(`/organization/delete`);',
    'const options = { cookieCache: { enabled: true } };',
    'const options = { ["secondaryStorage"]: adapter };',
    'options.cookieCache = {};',
    '@Controller("api/auth/users") class Controller {}',
    '@Controller("/api/auth") class Controller {}',
    '@Controller(`api/auth`) class Controller {}',
    '@Controller(["public", "api/auth"]) class Controller {}',
    '@Controller({ path: "api/auth" }) class Controller {}',
  ])('rejects prohibited syntax: %s', async (code) => {
    expect(await restrictions(code)).not.toEqual([]);
  });

  it.each([
    'typeof role === "string"',
    'typeof user.role !== "string"',
    'role === undefined',
    'role === 0',
    'role === false',
    'user.role === null',
    'role === DEFAULT_GLOBAL_ROLE',
    'memberRoleHasPermission(user.role, permission)',
    '@MemberHasPermission({ permissions: {} }) class Controller {}',
    '@Controller("api/organizations") class Controller {}',
    '// role === "owner"; cookieCache; removeUser();\n const ok = true;',
    '/* import SDK from "resend"; @Controller("api/auth") */ const ok = true;',
  ])('allows safe syntax and ignores comments: %s', async (code) => {
    expect(await restrictions(code)).toEqual([]);
  });

  it('permits role names only in the policy definition file', async () => {
    const file = 'src/infrastructure/auth/permissions.ts';
    expect(await restrictions('export const OWNER = "owner";', file)).toEqual(
      [],
    );
    expect(await restrictions('role === "admin"', file)).not.toEqual([]);
  });

  it('retains the CLI-only createUser restriction alongside the new rules', async () => {
    expect(await restrictions('auth.api.createUser({});')).not.toEqual([]);
    expect(await restrictions('auth.api["createUser"]({});')).not.toEqual([]);
    expect(
      await restrictions('auth.api.createUser({});', 'src/cli/fixture.ts'),
    ).toEqual([]);
    expect(
      await restrictions('auth.api.removeUser({});', 'src/cli/fixture.ts'),
    ).not.toEqual([]);
  });

  it('exempts only hard-delete keys in the super-admin guard table', async () => {
    const file = 'src/infrastructure/auth/auth-hooks.ts';
    expect(
      await restrictions(
        'export const SUPER_ADMIN_GUARDED_PATHS: Record<string, string> = { "/admin/remove-user": "delete" };',
        file,
      ),
    ).toEqual([]);
    expect(
      await restrictions(
        'export const SUPER_ADMIN_GUARDED_PATHS = { key: "/admin/remove-user" };',
        file,
      ),
    ).not.toEqual([]);
    expect(
      await restrictions(
        'export const SUPER_ADMIN_GUARDED_PATHS = { "/admin/remove-user": auth.api.removeUser({}) };',
        file,
      ),
    ).not.toEqual([]);
    expect(
      await restrictions(
        'const other = { "/admin/remove-user": "delete" };',
        file,
      ),
    ).not.toEqual([]);
  });

  it('does not grant the guard-table exception to a same-named local object', async () => {
    expect(
      await restrictions(
        'const SUPER_ADMIN_GUARDED_PATHS = { "/admin/remove-user": "delete" };',
        'src/infrastructure/auth/auth-hooks.ts',
      ),
    ).not.toEqual([]);
  });

  it.each(['MemberHasPermission', 'UserHasPermission'])(
    'pairs RequireActiveOrg with %s in either decorator order',
    async (permission) => {
      const active = '@RequireActiveOrg()';
      const authorized = `@${permission}({ permissions: {} })`;
      for (const decorators of [
        `${active}\n${authorized}`,
        `${authorized}\n${active}`,
        `${active}\n/* ${'spacing '.repeat(100)} */\n${authorized}`,
      ]) {
        expect(
          await restrictions(`class Controller { ${decorators} route() {} }`),
        ).toEqual([]);
      }
      expect(
        await restrictions(`${active}\n${authorized}\nclass Controller {}`),
      ).toEqual([]);
    },
  );

  it.each([
    'class Controller { @RequireActiveOrg() route() {} }',
    'class Controller { @RequireActiveOrg route() {} }',
    'class Controller { @RequireActiveOrg() route() {} @UserHasPermission({}) other() {} }',
    'class Controller { @RequireActiveOrg() route() { return "@MemberHasPermission"; } }',
    '@RequireActiveOrg() class Controller {}',
  ])('rejects an unpaired active-organization decorator: %s', async (code) => {
    expect(await restrictions(code)).not.toEqual([]);
  });

  it('keeps source-only rules out of test fixtures and i18n', async () => {
    expect(
      await restrictions('const role = "owner";', 'test/unit/fixture.spec.ts'),
    ).toEqual([]);
    expect(
      await restrictions(
        'const role = "owner";',
        'src/infrastructure/i18n/fixture.ts',
      ),
    ).toEqual([]);
  });
});

describe('run use-case imports through the Control Plane ESLint configuration', () => {
  const USE_CASE = 'src/modules/runs/fixture.use-case.ts';
  const COMPOSITION = 'src/modules/runs/fixture.module.ts';

  it.each([
    'bullmq',
    'bullmq/dist/esm/classes/job',
    'ioredis',
    '../../infrastructure/queue',
    '../../infrastructure/queue/queue-producer.service',
    '../queue',
    '../../ai/infrastructure/runtimes/mastra/mastra.runtime',
    '../../workers/handlers/agent-execution.handler',
    '../../api/main',
    '../../cli/main',
  ])('rejects use-case import syntax variations for %s', async (specifier) => {
    for (const form of importForms) {
      const messages = await restrictions(form(specifier), USE_CASE);

      expect(messages).not.toEqual([]);
    }
  });

  it.each([
    '../../ai/execution/agent-run.service',
    '../../ai/execution/agent-runtime',
    '../../infrastructure/outbox/outbox.repository',
    '../../infrastructure/database',
    '@nestjs/common',
  ])('allows a use case to depend on %s', async (specifier) => {
    expect(
      await restrictions(`import { X } from '${specifier}';`, USE_CASE),
    ).toEqual([]);
  });

  it('leaves composition free to name the transports it wires', async () => {
    expect(
      await restrictions(
        "import { QueueModule } from '../../infrastructure/queue';",
        COMPOSITION,
      ),
    ).toEqual([]);
  });
});
