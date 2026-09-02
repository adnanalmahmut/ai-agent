import { describe, expect, it, jest } from '@jest/globals';

import type { SmtpMailConfig } from '../../config/mail.config';
import { MailDeliveryError } from '../mail-transport';
import { SmtpMailTransport } from '../smtp-mail.transport';
import type { OutboundMail } from '../mail.types';

const PASSWORD = 'LEAKY_SMTP_PASSWORD';

const config = (overrides: Partial<SmtpMailConfig> = {}): SmtpMailConfig => ({
  driver: 'smtp',
  from: { address: 'no-reply@example.com', name: 'API Service' },
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  timeoutMs: 5000,
  ...overrides,
});

const mail = (overrides: Partial<OutboundMail> = {}): OutboundMail => ({
  to: 'recipient@example.com',
  from: { address: 'no-reply@example.com', name: 'API Service' },
  subject: 'Verify your email address',
  html: '<!doctype html><html><body>hi</body></html>',
  meta: { template: 'EMAIL_VERIFICATION', locale: 'en', direction: 'ltr' },
  ...overrides,
});

type Transporterish = {
  options: Record<string, unknown>;
  sendMail: unknown;
  close: unknown;
};

const internals = (transport: SmtpMailTransport) =>
  (transport as unknown as { transporter: Transporterish }).transporter;

function stubSendMail(
  transport: SmtpMailTransport,
  sendMail: (...args: unknown[]) => unknown,
) {
  internals(transport).sendMail = sendMail;
}

/** Shaped like a Nodemailer SMTP error. */
const smtpError = (
  code: string,
  responseCode: number | undefined,
  response: string,
) => Object.assign(new Error(response), { code, responseCode, response });

describe('SmtpMailTransport', () => {
  describe('transporter construction', () => {
    it('pools connections instead of dialling per message', () => {
      const options = internals(new SmtpMailTransport(config())).options;

      expect(options).toMatchObject({
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        pool: true,
      });
    });

    it('applies the configured timeouts', () => {
      const options = internals(
        new SmtpMailTransport(config({ timeoutMs: 2500 })),
      ).options;

      expect(options).toMatchObject({
        connectionTimeout: 2500,
        greetingTimeout: 2500,
        socketTimeout: 2500,
      });
    });

    it('supports implicit TLS', () => {
      const options = internals(
        new SmtpMailTransport(config({ port: 465, secure: true })),
      ).options;

      expect(options).toMatchObject({ port: 465, secure: true });
    });

    it('configures authentication when credentials are supplied', () => {
      const options = internals(
        new SmtpMailTransport(
          config({ auth: { user: 'mailer', password: PASSWORD } }),
        ),
      ).options;

      expect(options).toMatchObject({
        auth: { user: 'mailer', pass: PASSWORD },
      });
    });

    /**
     * `auth` has to be absent, not empty: Nodemailer reads a present `auth` as
     * an instruction to authenticate, and an anonymous relay would reject the
     * session. This is what keeps local MailHog/Mailpit setups working.
     */
    it('omits auth entirely for an unauthenticated relay', () => {
      const options = internals(new SmtpMailTransport(config())).options;

      expect(options.auth).toBeUndefined();
      expect(Object.keys(options)).not.toContain('auth');
    });
  });

  describe('successful delivery', () => {
    it('returns the message id reported by the server', async () => {
      const transport = new SmtpMailTransport(config());
      stubSendMail(transport, () =>
        Promise.resolve({ messageId: '<abc@example.com>' }),
      );

      await expect(transport.send(mail())).resolves.toEqual({
        provider: 'smtp',
        messageId: '<abc@example.com>',
      });
    });

    it('sends the rendered message with an RFC 5322 sender', async () => {
      const transport = new SmtpMailTransport(config());
      const sendMail = jest.fn<(message: unknown) => Promise<unknown>>(() =>
        Promise.resolve({ messageId: 'id' }),
      );
      stubSendMail(transport, sendMail);

      await transport.send(mail());

      expect(sendMail).toHaveBeenCalledWith({
        from: 'API Service <no-reply@example.com>',
        to: 'recipient@example.com',
        subject: 'Verify your email address',
        html: '<!doctype html><html><body>hi</body></html>',
      });
    });
  });

  describe('failure', () => {
    it('wraps an authentication failure', async () => {
      const transport = new SmtpMailTransport(config());
      stubSendMail(transport, () =>
        Promise.reject(smtpError('EAUTH', 535, '535 auth failed')),
      );

      const error = await transport.send(mail()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(MailDeliveryError);
      expect((error as Error).message).toBe(
        'SMTP delivery failed (EAUTH, response 535)',
      );
    });

    it('wraps a connection failure with no response code', async () => {
      const transport = new SmtpMailTransport(config());
      stubSendMail(transport, () =>
        Promise.reject(
          smtpError('ECONNECTION', undefined, 'connect ECONNREFUSED'),
        ),
      );

      await expect(transport.send(mail())).rejects.toThrow(
        /SMTP delivery failed \(ECONNECTION\)/,
      );
    });

    /**
     * Relays echo the envelope back in their response text, and on an auth
     * failure that text can include the username. Only the stable code and
     * numeric response reach the message.
     */
    it('keeps the server response text and password out of the message', async () => {
      const transport = new SmtpMailTransport(
        config({ auth: { user: 'mailer', password: PASSWORD } }),
      );
      stubSendMail(transport, () =>
        Promise.reject(
          smtpError('EAUTH', 535, `535 auth failed for mailer:${PASSWORD}`),
        ),
      );

      const error = await transport.send(mail()).catch((e: unknown) => e);

      expect((error as Error).message).not.toContain(PASSWORD);
      expect((error as Error).message).not.toContain('mailer');
      expect((error as MailDeliveryError).cause).toBeDefined();
    });
  });

  it('closes pooled connections on shutdown so the process can exit', () => {
    const transport = new SmtpMailTransport(config());
    const close = jest.fn();
    internals(transport).close = close;

    transport.onModuleDestroy();

    expect(close).toHaveBeenCalled();
  });
});
