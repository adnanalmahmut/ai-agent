import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PinoLogger } from 'nestjs-pino';

import type { LogMailConfig } from '../../../../src/infrastructure/config/mail.config';
import { LogMailTransport } from '../../../../src/infrastructure/mail/log-mail.transport';
import type { OutboundMail } from '../../../../src/infrastructure/mail/mail.types';

/** The single-use credential this whole test file exists to keep out of logs. */
const TOKEN = 'SUPER_SECRET_TOKEN_VALUE';

const ACTION_URL = `https://app.example.com/verify-email?token=${TOKEN}`;

const mail = (overrides: Partial<OutboundMail> = {}): OutboundMail => ({
  to: 'recipient@example.com',
  from: { address: 'no-reply@example.com', name: 'API Service' },
  subject: 'Verify your email address',
  html: `<!doctype html><html lang="en" dir="ltr"><body><a href="${ACTION_URL}">Verify</a></body></html>`,
  meta: { template: 'EMAIL_VERIFICATION', locale: 'en', direction: 'ltr' },
  ...overrides,
});

type LoggedCall = [Record<string, unknown>, string?];

function createLogger() {
  const info = jest.fn();

  const logger = {
    setContext: jest.fn(),
    info,
  } as unknown as PinoLogger;

  return {
    logger,
    calls: () => info.mock.calls as unknown as LoggedCall[],
    payload: () => (info.mock.calls as unknown as LoggedCall[])[0]?.[0],
  };
}

const config = (overrides: Partial<LogMailConfig> = {}): LogMailConfig => ({
  driver: 'log',
  from: { address: 'no-reply@example.com', name: 'API Service' },
  writeHtml: false,
  ...overrides,
});

describe('LogMailTransport', () => {
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    logger = createLogger();
  });

  it('reports the delivery as coming from the log provider', async () => {
    const transport = new LogMailTransport(config(), logger.logger);

    await expect(transport.send(mail())).resolves.toEqual({ provider: 'log' });
  });

  describe('logging policy', () => {
    it('logs exactly the whitelisted fields and nothing else', async () => {
      const transport = new LogMailTransport(config(), logger.logger);

      await transport.send(mail());

      // An exact key comparison, not a subset match: a future field added to
      // the log line has to be justified here before it can ship.
      expect(Object.keys(logger.payload()).sort()).toEqual([
        'direction',
        'event',
        'htmlBytes',
        'locale',
        'provider',
        'subject',
        'template',
        'to',
      ]);
    });

    it('carries the metadata needed to trace a delivery', async () => {
      const transport = new LogMailTransport(config(), logger.logger);

      await transport.send(mail());

      expect(logger.payload()).toMatchObject({
        event: 'mail.sent',
        provider: 'log',
        template: 'EMAIL_VERIFICATION',
        locale: 'en',
        direction: 'ltr',
        subject: 'Verify your email address',
      });
    });

    /**
     * The assertion this file is really for. Serializing the whole call the
     * way a log shipper would is the only check that survives someone adding
     * a field: matching on individual keys would miss a token smuggled in
     * under a new name.
     */
    it('never lets a token reach the log, in any field', async () => {
      const transport = new LogMailTransport(config(), logger.logger);

      await transport.send(mail());

      expect(JSON.stringify(logger.calls())).not.toContain(TOKEN);
    });

    it('does not log the action URL or the rendered body', async () => {
      const transport = new LogMailTransport(config(), logger.logger);

      await transport.send(mail());

      const serialized = JSON.stringify(logger.calls());

      expect(serialized).not.toContain(ACTION_URL);
      expect(serialized).not.toContain('<!doctype html');
    });

    it('masks the recipient', async () => {
      const transport = new LogMailTransport(config(), logger.logger);

      await transport.send(mail({ to: 'recipient@example.com' }));

      expect(logger.payload().to).toBe('r*******t@example.com');
      expect(JSON.stringify(logger.calls())).not.toContain(
        'recipient@example.com',
      );
    });

    it('masks a short local part without revealing its characters', async () => {
      const transport = new LogMailTransport(config(), logger.logger);

      await transport.send(mail({ to: 'ab@example.com' }));

      expect(logger.payload().to).toBe('**@example.com');
    });
  });

  describe('development HTML dump', () => {
    /**
     * The dump writes live account-takeover links to disk. Enabling it in
     * production has no legitimate use, so it must fail loudly at construction
     * rather than quietly at the first send.
     */
    it('refuses to construct when enabled in production', () => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        expect(
          () =>
            new LogMailTransport(config({ writeHtml: true }), logger.logger),
        ).toThrow(/MAIL_LOG_WRITE_HTML must not be enabled in production/);
      } finally {
        process.env.NODE_ENV = previous;
      }
    });

    describe('when enabled outside production', () => {
      let workspace: string;
      let previousCwd: string;

      beforeEach(() => {
        previousCwd = process.cwd();
        workspace = mkdtempSync(path.join(tmpdir(), 'mail-dump-'));
        process.chdir(workspace);
      });

      afterEach(() => {
        process.chdir(previousCwd);
        rmSync(workspace, { recursive: true, force: true });
      });

      const dumped = () => {
        const directory = path.join(workspace, '.tmp/mail');
        return readdirSync(directory).map((file) => ({
          file,
          contents: readFileSync(path.join(directory, file), 'utf8'),
        }));
      };

      it('writes the rendered message so it can be opened in a browser', async () => {
        const transport = new LogMailTransport(
          config({ writeHtml: true }),
          logger.logger,
        );

        await transport.send(mail());

        expect(dumped()).toHaveLength(1);
        expect(dumped()[0]?.contents).toContain(ACTION_URL);
      });

      it('names the file after the template and locale', async () => {
        const transport = new LogMailTransport(
          config({ writeHtml: true }),
          logger.logger,
        );

        await transport.send(mail());

        expect(dumped()[0]?.file).toMatch(/^\d+-EMAIL_VERIFICATION-en\.html$/);
      });

      /**
       * The dump exists so a developer can *see* the token-bearing link. That
       * is exactly why it must never be what the log shows.
       */
      it('still keeps the token out of the log', async () => {
        const transport = new LogMailTransport(
          config({ writeHtml: true }),
          logger.logger,
        );

        await transport.send(mail());

        expect(JSON.stringify(logger.calls())).not.toContain(TOKEN);
      });

      it('does not write anything when the dump is off', async () => {
        const transport = new LogMailTransport(config(), logger.logger);

        await transport.send(mail());

        expect(() => dumped()).toThrow();
      });
    });

    it('constructs in production when the dump is off', () => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        expect(
          () => new LogMailTransport(config(), logger.logger),
        ).not.toThrow();
      } finally {
        process.env.NODE_ENV = previous;
      }
    });
  });
});
