import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The dependency rules that make this design more than a diagram.
 *
 * Every claim here is one a reviewer would otherwise have to re-check by hand
 * on every pull request: that Better Auth cannot see a provider SDK, that
 * `MailService` cannot see a transport, that nothing in here reaches for
 * ambient request state. They are cheap to state and expensive to rediscover
 * after they have quietly stopped being true.
 */

const MAIL_DIR = path.join(process.cwd(), 'src/infrastructure/mail');

const PROVIDER_SDKS = [
  'resend',
  'nodemailer',
  '@aws-sdk',
  '@aws-sdk/client-sesv2',
  'postmark',
  'sendgrid',
];

/** Production sources only — specs legitimately reach into internals. */
const sourceFiles = readdirSync(MAIL_DIR).filter(
  (file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'),
);

function importsOf(file: string): string[] {
  const source = readFileSync(path.join(MAIL_DIR, file), 'utf8');

  // Module specifiers only. Matching raw text would trip over the prose in
  // `mail-renderer.service.ts`, which *names* `I18nContext` precisely to say
  // it must never be used.
  return [...source.matchAll(/from\s+'([^']+)'|import\s+'([^']+)'/g)].map(
    (match) => match[1] ?? match[2] ?? '',
  );
}

const eachFile = sourceFiles.map((file) => [file] as const);

describe('infrastructure/mail boundaries', () => {
  it('has sources to check', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  /** Mail is a capability auth depends on; it must not depend on auth back. */
  it.each(eachFile)('%s does not import Better Auth', (file) => {
    expect(importsOf(file)).not.toContainEqual(
      expect.stringMatching(/better-auth/),
    );
  });

  /**
   * The rule that keeps `MAIL_DRIVER=resend` from becoming an architecture
   * decision: only an adapter may name a vendor.
   */
  it.each(eachFile)(
    '%s imports a provider SDK only if it is a transport',
    (file) => {
      const offending = importsOf(file).filter((specifier) =>
        PROVIDER_SDKS.some((sdk) => specifier.startsWith(sdk)),
      );

      // Two adapter shapes may name a vendor: the auth-mail transports, and
      // the governed-notification delivery adapters, which exist beside them
      // precisely because they carry a provider idempotency key the transport
      // interface does not.
      if (
        file.endsWith('-mail.transport.ts') ||
        file.endsWith('-notification.delivery.ts')
      ) {
        return;
      }

      expect(offending).toEqual([]);
    },
  );

  /**
   * Ambient request state is how a retry ends up in a different language than
   * the original attempt. The locale travels on the job instead.
   */
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
    // Export clauses only. The doc comment in `index.ts` names these symbols
    // in order to say they are deliberately absent — scanning raw text would
    // read that explanation as the violation it warns about.
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
