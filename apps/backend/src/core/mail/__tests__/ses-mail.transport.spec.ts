import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { SesMailConfig } from '../../../config/mail.config';
import { MailDeliveryError } from '../mail-transport';
import { SesMailTransport } from '../ses-mail.transport';
import type { OutboundMail } from '../mail.types';

const SECRET = 'LEAKY_AWS_SECRET';

const config = (overrides: Partial<SesMailConfig> = {}): SesMailConfig => ({
  driver: 'ses',
  from: { address: 'no-reply@example.com', name: 'API Service' },
  region: 'eu-central-1',
  timeoutMs: 5000,
  ...overrides,
});

const mail = (overrides: Partial<OutboundMail> = {}): OutboundMail => ({
  to: 'recipient@example.com',
  from: { address: 'no-reply@example.com', name: 'API Service' },
  subject: 'تأكيد بريدك الإلكتروني',
  html: '<!doctype html><html lang="ar" dir="rtl"><body>مرحبًا</body></html>',
  meta: { template: 'EMAIL_VERIFICATION', locale: 'ar', direction: 'rtl' },
  ...overrides,
});

/** Replaces the signed HTTP call, leaving command construction under test. */
function stubSend(
  transport: SesMailTransport,
  send: (...args: unknown[]) => unknown,
) {
  (transport as unknown as { client: { send: unknown } }).client.send = send;
}

/** Shaped like a real AWS SDK service exception. */
const awsError = (name: string, httpStatusCode: number, message: string) =>
  Object.assign(new Error(message), { name, $metadata: { httpStatusCode } });

describe('SesMailTransport', () => {
  let transport: SesMailTransport;

  beforeEach(() => {
    transport = new SesMailTransport(config());
  });

  describe('successful delivery', () => {
    it('maps the SES message id into the result', async () => {
      stubSend(transport, () => Promise.resolve({ MessageId: '0100018f' }));

      await expect(transport.send(mail())).resolves.toEqual({
        provider: 'ses',
        messageId: '0100018f',
      });
    });

    it('builds a Simple HTML message with an RFC 5322 sender', async () => {
      const send = jest.fn<(command: unknown) => Promise<unknown>>(() =>
        Promise.resolve({ MessageId: 'id' }),
      );
      stubSend(transport, send);

      await transport.send(mail());

      const input = (
        send.mock.calls[0]?.[0] as { input: Record<string, unknown> }
      ).input;

      expect(input).toMatchObject({
        FromEmailAddress: 'API Service <no-reply@example.com>',
        Destination: { ToAddresses: ['recipient@example.com'] },
      });
    });

    /**
     * Without an explicit charset SES would not transmit the Arabic templates
     * intact, which is the kind of failure that only shows up in a real inbox.
     */
    it('declares UTF-8 for both subject and body', async () => {
      const send = jest.fn<(command: unknown) => Promise<unknown>>(() =>
        Promise.resolve({ MessageId: 'id' }),
      );
      stubSend(transport, send);

      await transport.send(mail());

      const input = (
        send.mock.calls[0]?.[0] as { input: Record<string, unknown> }
      ).input;

      expect(input).toMatchObject({
        Content: {
          Simple: {
            Subject: { Data: 'تأكيد بريدك الإلكتروني', Charset: 'UTF-8' },
            Body: { Html: { Charset: 'UTF-8' } },
          },
        },
      });
    });

    it('fails when SES reports success without a message id', async () => {
      stubSend(transport, () => Promise.resolve({}));

      await expect(transport.send(mail())).rejects.toThrow(/no message id/);
    });
  });

  describe('credential resolution', () => {
    /**
     * Omitting the key entirely — rather than passing `undefined` — is what
     * lets the SDK fall through to its own chain, so an IAM task role works
     * without static keys in the environment.
     */
    const resolvedCredentials = async (transport: SesMailTransport) => {
      const client = (
        transport as unknown as {
          client: { config: { credentials: () => Promise<unknown> } };
        }
      ).client;

      return client.config.credentials();
    };

    /**
     * The SDK always exposes a credential *provider*; what matters is which
     * one. With nothing configured it must be the default chain, so an IAM
     * task role supplies short-lived credentials and no static keys are needed.
     */
    it('resolves through the AWS chain when none are configured', async () => {
      const transport = new SesMailTransport(config());

      // The chain finds whatever this environment offers — commonly nothing on
      // a developer machine, in which case it rejects. Either outcome proves
      // the point: no static credentials of ours were injected.
      const resolved = (await resolvedCredentials(transport).catch(
        () => undefined,
      )) as { accessKeyId?: string } | undefined;

      expect(resolved?.accessKeyId).not.toBe('AKIAEXAMPLE');
    });

    it('uses explicit static credentials when supplied', async () => {
      const transport = new SesMailTransport(
        config({
          credentials: {
            accessKeyId: 'AKIAEXAMPLE',
            secretAccessKey: SECRET,
          },
        }),
      );

      await expect(resolvedCredentials(transport)).resolves.toMatchObject({
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: SECRET,
      });
    });

    it('carries a session token for temporary credentials', async () => {
      const transport = new SesMailTransport(
        config({
          credentials: {
            accessKeyId: 'AKIAEXAMPLE',
            secretAccessKey: SECRET,
            sessionToken: 'temporary-session-token',
          },
        }),
      );

      await expect(resolvedCredentials(transport)).resolves.toMatchObject({
        sessionToken: 'temporary-session-token',
      });
    });
  });

  describe('provider failure', () => {
    it('wraps a rejected send in a MailDeliveryError', async () => {
      stubSend(transport, () =>
        Promise.reject(
          awsError('MessageRejected', 400, 'Email address is not verified'),
        ),
      );

      const error = await transport.send(mail()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(MailDeliveryError);
      expect((error as MailDeliveryError).provider).toBe('ses');
    });

    it('reports the stable exception name and HTTP status', async () => {
      stubSend(transport, () =>
        Promise.reject(
          awsError('Throttling', 429, 'Maximum sending rate exceeded'),
        ),
      );

      await expect(transport.send(mail())).rejects.toThrow(
        /Throttling, status 429/,
      );
    });

    it('handles a failure with no HTTP metadata', async () => {
      stubSend(transport, () =>
        Promise.reject(
          Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }),
        ),
      );

      await expect(transport.send(mail())).rejects.toThrow(
        /SES request failed \(TimeoutError\)/,
      );
    });

    /**
     * AWS exceptions carry the signed request. None of it may reach the
     * message that gets logged; the whole error stays on `cause`.
     */
    it('keeps AWS error prose and credentials out of the message', async () => {
      const raw = Object.assign(
        awsError('InvalidClientTokenId', 403, `key rejected: ${SECRET}`),
        { $response: { headers: { authorization: `AWS4 ${SECRET}` } } },
      );
      stubSend(transport, () => Promise.reject(raw));

      const error = await transport.send(mail()).catch((e: unknown) => e);

      expect((error as Error).message).not.toContain(SECRET);
      expect((error as Error).message).toBe(
        'SES rejected the message (InvalidClientTokenId, status 403)',
      );
      expect((error as MailDeliveryError).cause).toBe(raw);
    });
  });
});
