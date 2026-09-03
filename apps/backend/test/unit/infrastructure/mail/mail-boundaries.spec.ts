import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MAIL_DIR = path.join(process.cwd(), 'src/infrastructure/mail');

const PROVIDER_SDKS = [
  'resend',
  'nodemailer',
  '@aws-sdk',
  '@aws-sdk/client-sesv2',
  'postmark',
  'sendgrid',
];

const sourceFiles = readdirSync(MAIL_DIR).filter(
  (file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'),
);

function importsOf(file: string): string[] {
  const source = readFileSync(path.join(MAIL_DIR, file), 'utf8');

  return [...source.matchAll(/from\s+'([^']+)'|import\s+'([^']+)'/g)].map(
    (match) => match[1] ?? match[2] ?? '',
  );
}

const eachFile = sourceFiles.map((file) => [file] as const);

describe('infrastructure/mail boundaries', () => {
  it('has sources to check', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it.each(eachFile)('%s does not import Better Auth', (file) => {
    expect(importsOf(file)).not.toContainEqual(
      expect.stringMatching(/better-auth/),
    );
  });

  it.each(eachFile)(
    '%s imports a provider SDK only if it is a transport',
    (file) => {
      const offending = importsOf(file).filter((specifier) =>
        PROVIDER_SDKS.some((sdk) => specifier.startsWith(sdk)),
      );

      if (
        file.endsWith('-mail.transport.ts') ||
        file.endsWith('-notification.delivery.ts')
      ) {
        return;
      }

      expect(offending).toEqual([]);
    },
  );

  it.each(eachFile)('%s does not reach for ambient i18n context', (file) => {
    expect(importsOf(file)).not.toContain('nestjs-i18n');
  });

  it('MailService depends on the abstraction, never on a transport', () => {
    const specifiers = importsOf('mail.service.ts');

    expect(specifiers).toContain('./mail-transport');
    expect(specifiers).not.toContainEqual(
      expect.stringMatching(/\.transport$/),
    );
  });

  it('does not export the transport token from the module surface', () => {
    const surface = readFileSync(path.join(MAIL_DIR, 'index.ts'), 'utf8');

    const exported = [
      ...surface.matchAll(/export\s+(?:type\s+)?{([^}]*)}/g),
    ].flatMap((match) =>
      (match[1] ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
    );

    expect(exported).toContain('MailService');
    expect(exported).not.toContain('MAIL_TRANSPORT');
    expect(exported).not.toContain('MailTransport');
    expect(exported).not.toContain('OutboundMail');
  });
});
