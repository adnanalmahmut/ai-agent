import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { ResendMailConfig } from '../../../config/mail.config';
import { MailDeliveryError } from '../mail-transport';
import { ResendMailTransport } from '../resend-mail.transport';
import type { OutboundMail } from '../mail.types';

const API_KEY = 'LEAKY_RESEND_KEY';

const config = (
  overrides: Partial<ResendMailConfig> = {},
): ResendMailConfig => ({
  driver: 'resend',
  from: { address: 'no-reply@example.com', name: 'API Service' },
  apiKey: API_KEY,
  timeoutMs: 50,
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

/** Replaces the SDK's HTTP call while leaving the transport's logic intact. */
function stubClient(
  transport: ResendMailTransport,
  send: (...args: unknown[]) => unknown,
) {
  const client = (
    transport as unknown as { client: { emails: { send: unknown } } }
  ).client;
  client.emails.send = send;
}

describe('ResendMailTransport', () => {
  let transport: ResendMailTransport;

  beforeEach(() => {
    transport = new ResendMailTransport(config());
  });

  describe('successful delivery', () => {
    it('maps the provider message id into the result', async () => {
      stubClient(transport, () =>
        Promise.resolve({ data: { id: 're_123' }, error: null }),
      );

      await expect(transport.send(mail())).resolves.toEqual({
        provider: 'resend',
        messageId: 're_123',
      });
    });

    it('sends the rendered message with an RFC 5322 sender', async () => {
      const send = jest.fn<(payload: unknown) => Promise<unknown>>(() =>
        Promise.resolve({ data: { id: 're_1' }, error: null }),
      );
      stubClient(transport, send);

      await transport.send(mail());

      expect(send).toHaveBeenCalledWith({
        from: 'API Service <no-reply@example.com>',
        to: ['recipient@example.com'],
        subject: 'Verify your email address',
        html: '<!doctype html><html><body>hi</body></html>',
      });
    });

    /**
     * The sender travels on the envelope that `MailService` builds, not on the
     * transport's own config — so this is what an operator-configured display
     * name actually does to the header.
     */
    it('quotes a display name that would otherwise break the header', async () => {
      const send = jest.fn<(payload: unknown) => Promise<unknown>>(() =>
        Promise.resolve({ data: { id: 're_1' }, error: null }),
      );
      stubClient(transport, send);

      await transport.send(
        mail({ from: { address: 'a@b.com', name: 'Acme, Inc. <ops>' } }),
      );

      expect(send.mock.calls[0]?.[0]).toMatchObject({
        from: '"Acme, Inc. <ops>" <a@b.com>',
      });
    });
  });

  /**
   * The SDK resolves `{ data, error }` rather than throwing, so an
   * implementation that only wrapped the call in try/catch would report every
   * rejected send as a success. These are the cases that catch that.
   */
  describe('provider rejection', () => {
    const rejection = (name: string, statusCode: number, message: string) => ({
      data: null,
      error: { name, statusCode, message },
    });

    it('fails on invalid credentials rather than resolving', async () => {
      stubClient(transport, () =>
        Promise.resolve(
          rejection('invalid_api_key', 401, 'API key is invalid'),
        ),
      );

      await expect(transport.send(mail())).rejects.toBeInstanceOf(
        MailDeliveryError,
      );
    });

    it('reports the stable provider code and status', async () => {
      stubClient(transport, () =>
        Promise.resolve(
          rejection('rate_limit_exceeded', 429, 'Too many requests'),
        ),
      );

      await expect(transport.send(mail())).rejects.toThrow(
        /rate_limit_exceeded, status 429/,
      );
    });

    it('treats a validation error as a delivery failure', async () => {
      stubClient(transport, () =>
        Promise.resolve(
          rejection('validation_error', 422, 'Invalid `to` field'),
        ),
      );

      await expect(transport.send(mail())).rejects.toBeInstanceOf(
        MailDeliveryError,
      );
    });

    it('fails when the provider returns neither an id nor an error', async () => {
      stubClient(transport, () => Promise.resolve({ data: null, error: null }));

      await expect(transport.send(mail())).rejects.toThrow(
        /neither an error nor a message id/,
      );
    });

    /**
     * Resend's prose can quote the payload it rejected, including the
     * recipient. The thrown message is built from the stable code instead, and
     * the raw error is parked on `cause` — which the logging policy never
     * serializes.
     */
    it('keeps provider prose out of the error message', async () => {
      stubClient(transport, () =>
        Promise.resolve(
          rejection(
            'validation_error',
            422,
            'recipient@example.com is suppressed',
          ),
        ),
      );

      const error = await transport.send(mail()).catch((e: unknown) => e);

      expect((error as Error).message).not.toContain('recipient@example.com');
      expect((error as Error).message).not.toContain('suppressed');
      expect((error as MailDeliveryError).cause).toMatchObject({
        name: 'validation_error',
      });
    });

    it('never puts the API key in the error message', async () => {
      stubClient(transport, () =>
        Promise.resolve(rejection('invalid_api_key', 401, `key ${API_KEY}`)),
      );

      const error = await transport.send(mail()).catch((e: unknown) => e);

      expect((error as Error).message).not.toContain(API_KEY);
    });
  });

  describe('transport-level failure', () => {
    it('wraps a thrown network error', async () => {
      stubClient(transport, () =>
        Promise.reject(new Error('getaddrinfo ENOTFOUND api.resend.com')),
      );

      const error = await transport.send(mail()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(MailDeliveryError);
      expect((error as Error).message).toMatch(
        /before a response was received/,
      );
    });

    it('gives up when the provider stalls past the timeout', async () => {
      stubClient(transport, () => new Promise(() => {}));

      const error = await transport.send(mail()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(MailDeliveryError);
      expect((error as Error).message).toMatch(/did not respond within 50ms/);
    });

    it('reports the provider that failed', async () => {
      stubClient(transport, () => Promise.reject(new Error('socket hang up')));

      const error = await transport.send(mail()).catch((e: unknown) => e);

      expect((error as MailDeliveryError).provider).toBe('resend');
    });
  });
});
