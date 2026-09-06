import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';

import mailConfig, {
  type LogMailConfig,
} from '../../../../src/infrastructure/config/mail.config';
import { AppI18nModule } from '../../../../src/infrastructure/i18n';
import { MailRendererService } from '../../../../src/infrastructure/mail/mail-renderer.service';
import {
  MAIL_TRANSPORT,
  MailDeliveryError,
} from '../../../../src/infrastructure/mail/mail-transport';
import type { MailTransport } from '../../../../src/infrastructure/mail/mail-transport';
import { MailService } from '../../../../src/infrastructure/mail/mail.service';
import type {
  MailDeliveryResult,
  MailJob,
  OutboundMail,
} from '../../../../src/infrastructure/mail/mail.types';

const TOKEN = 'SUPER_SECRET_TOKEN_VALUE';

const verificationJob: MailJob = {
  template: 'EMAIL_VERIFICATION',
  locale: 'en',
  to: 'recipient@example.com',
  variables: {
    name: 'Adnan',
    actionUrl: `https://app.example.com/verify-email?token=${TOKEN}`,
  },
};

const CONFIG: LogMailConfig = {
  driver: 'log',
  from: { address: 'no-reply@example.com', name: 'API Service' },
  writeHtml: false,
};

class RecordingTransport implements MailTransport {
  readonly sent: OutboundMail[] = [];
  failure: Error | undefined;

  send(mail: OutboundMail): Promise<MailDeliveryResult> {
    this.sent.push(mail);

    if (this.failure) return Promise.reject(this.failure);

    return Promise.resolve({ provider: 'log', messageId: 'test-id' });
  }

  get last(): OutboundMail {
    const mail = this.sent.at(-1);
    if (!mail) throw new Error('No mail was sent');
    return mail;
  }
}

type LoggedCall = [Record<string, unknown>, string?];

describe('MailService', () => {
  let service: MailService;
  let transport: RecordingTransport;
  let errorCalls: () => LoggedCall[];

  beforeEach(async () => {
    transport = new RecordingTransport();
    const error = jest.fn();
    errorCalls = () => error.mock.calls as unknown as LoggedCall[];

    const moduleRef = await Test.createTestingModule({
      imports: [AppI18nModule],
      providers: [
        MailRendererService,
        MailService,
        { provide: MAIL_TRANSPORT, useValue: transport },
        { provide: mailConfig.KEY, useValue: CONFIG },
        {
          provide: PinoLogger,
          useValue: { setContext: jest.fn(), info: jest.fn(), error },
        },
      ],
    }).compile();

    service = moduleRef.get(MailService);
  });

  describe('send', () => {
    it('hands the transport the rendered message and the configured sender', async () => {
      await service.send(verificationJob);

      expect(transport.last).toMatchObject({
        to: 'recipient@example.com',
        from: { address: 'no-reply@example.com', name: 'API Service' },
        subject: 'Verify your email address',
        meta: {
          template: 'EMAIL_VERIFICATION',
          locale: 'en',
          direction: 'ltr',
        },
      });
    });

    it('returns the transport result', async () => {
      await expect(service.send(verificationJob)).resolves.toEqual({
        provider: 'log',
        messageId: 'test-id',
      });
    });

    it('renders an English job left-to-right', async () => {
      await service.send(verificationJob);

      expect(transport.last.html).toContain('<html lang="en" dir="ltr">');
      expect(transport.last.meta.direction).toBe('ltr');
    });

    it('renders an Arabic job right-to-left', async () => {
      await service.send({ ...verificationJob, locale: 'ar' });

      expect(transport.last.html).toContain('<html lang="ar" dir="rtl">');
      expect(transport.last.meta.direction).toBe('rtl');
      expect(transport.last.subject).toBe('تأكيد بريدك الإلكتروني');
    });

    it('propagates a delivery failure to the caller', async () => {
      transport.failure = new MailDeliveryError('log', 'Provider unavailable');

      await expect(service.send(verificationJob)).rejects.toBeInstanceOf(
        MailDeliveryError,
      );
    });
  });

  describe('dispatch', () => {
    it('delivers the same message send would', async () => {
      service.dispatch(verificationJob);
      await flush();

      expect(transport.last.subject).toBe('Verify your email address');
    });

    it('returns immediately rather than waiting for delivery', () => {
      expect(service.dispatch(verificationJob)).toBeUndefined();
    });

    it('swallows a transport failure without an unhandled rejection', async () => {
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);

      try {
        transport.failure = new MailDeliveryError(
          'log',
          'Provider unavailable',
        );

        expect(() => service.dispatch(verificationJob)).not.toThrow();
        await flush();

        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('logs the failure with metadata that can be alerted on', async () => {
      transport.failure = new MailDeliveryError('log', 'Provider unavailable');

      service.dispatch(verificationJob);
      await flush();

      expect(errorCalls()[0]?.[0]).toMatchObject({
        event: 'mail.failed',
        template: 'EMAIL_VERIFICATION',
        locale: 'en',
        errorName: 'MailDeliveryError',
        errorMessage: 'Provider unavailable',
      });
    });

    it('masks the recipient in the failure log', async () => {
      transport.failure = new MailDeliveryError('log', 'Provider unavailable');

      service.dispatch(verificationJob);
      await flush();

      expect(errorCalls()[0]?.[0]).toMatchObject({
        to: 'r*******t@example.com',
      });
      expect(JSON.stringify(errorCalls())).not.toContain(
        'recipient@example.com',
      );
    });

    it('never logs the underlying provider error', async () => {
      transport.failure = new MailDeliveryError('log', 'Request failed', {
        request: { headers: { authorization: 'Bearer LEAKY_SDK_SECRET' } },
      });

      service.dispatch(verificationJob);
      await flush();

      expect(JSON.stringify(errorCalls())).not.toContain('LEAKY_SDK_SECRET');
    });

    it('does not leak the action token when delivery fails', async () => {
      transport.failure = new MailDeliveryError('log', 'Provider unavailable');

      service.dispatch(verificationJob);
      await flush();

      expect(JSON.stringify(errorCalls())).not.toContain(TOKEN);
    });

    it('survives a renderer failure as well as a transport one', async () => {
      const broken = {
        ...verificationJob,
        template: 'NO_SUCH_TEMPLATE',
      } as unknown as MailJob;

      expect(() => service.dispatch(broken)).not.toThrow();
      await flush();

      expect(errorCalls()[0]?.[0]).toMatchObject({ event: 'mail.failed' });
    });
  });

  describe('template typing', () => {
    it('binds each template to its own variables at compile time', () => {
      // @ts-expect-error PASSWORD_RESET also requires `expiresInMinutes`.
      const missing: MailJob = {
        template: 'PASSWORD_RESET',
        locale: 'ar',
        to: 'a@example.com',
        variables: { name: 'Adnan', actionUrl: 'https://example.com' },
      };

      const foreign: MailJob = {
        template: 'EMAIL_VERIFICATION',
        locale: 'ar',
        to: 'a@example.com',
        variables: {
          name: 'Adnan',
          actionUrl: 'https://example.com',
          // @ts-expect-error `expiresInMinutes` does not belong to EMAIL_VERIFICATION.
          expiresInMinutes: 30,
        },
      };

      expect([missing, foreign]).toHaveLength(2);
    });
  });
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
