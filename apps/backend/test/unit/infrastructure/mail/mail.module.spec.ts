import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Inject, Injectable, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';

import { configurations } from '../../../../src/infrastructure/config';
import { AppI18nModule } from '../../../../src/infrastructure/i18n';
import { LogMailTransport } from '../../../../src/infrastructure/mail/log-mail.transport';
import {
  MAIL_TRANSPORT,
  type MailTransport,
} from '../../../../src/infrastructure/mail/mail-transport';
import { MailModule } from '../../../../src/infrastructure/mail/mail.module';
import { MailService } from '../../../../src/infrastructure/mail/mail.service';
import { ResendMailTransport } from '../../../../src/infrastructure/mail/resend-mail.transport';
import { SesMailTransport } from '../../../../src/infrastructure/mail/ses-mail.transport';
import { SmtpMailTransport } from '../../../../src/infrastructure/mail/smtp-mail.transport';

@Injectable()
class ConsumerService {
  constructor(readonly mail: MailService) {}
}

@Module({ imports: [MailModule], providers: [ConsumerService] })
class ConsumerModule {}

@Injectable()
class LeakyService {
  constructor(@Inject(MAIL_TRANSPORT) readonly transport: MailTransport) {}
}

@Module({ imports: [MailModule], providers: [LeakyService] })
class LeakyModule {}

const LOG_ENV = {
  MAIL_DRIVER: 'log',
  MAIL_FROM_ADDRESS: 'no-reply@example.com',
  APP_ENCRYPTION_KEY: 'dGVzdC1vbmx5LWZha2UtbWFzdGVyLWtleS0zMmJ5dGU=',
  APP_ENCRYPTION_ACTIVE_KEY_VERSION: 'test-v1',
  APP_ENCRYPTION_DECRYPT_KEYS: '',
};

async function bootWith(
  env: Record<string, string>,
  consumer: new (...args: never[]) => unknown,
) {
  Object.assign(process.env, env);

  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: configurations }),
      LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
      AppI18nModule,
      consumer,
    ],
  }).compile();
}

describe('MailModule', () => {
  const original = process.env;

  beforeEach(() => {
    process.env = { ...original };
    for (const key of [
      'RESEND_API_KEY',
      'AWS_REGION',
      'SMTP_HOST',
      'SMTP_USER',
      'SMTP_PASSWORD',
    ]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = original;
  });

  it('binds the transport named by MAIL_DRIVER', async () => {
    const moduleRef = await bootWith(LOG_ENV, ConsumerModule);

    expect(moduleRef.get(MAIL_TRANSPORT, { strict: false })).toBeInstanceOf(
      LogMailTransport,
    );

    await moduleRef.close();
  });

  it('lets an importing module inject MailService', async () => {
    const moduleRef = await bootWith(LOG_ENV, ConsumerModule);

    expect(
      moduleRef.get(ConsumerService, { strict: false }).mail,
    ).toBeInstanceOf(MailService);

    await moduleRef.close();
  });

  it('refuses to let an importing module inject the transport', async () => {
    await expect(bootWith(LOG_ENV, LeakyModule)).rejects.toThrow(
      /Nest can't resolve dependencies of the LeakyService/,
    );
  });

  describe.each([
    [
      'resend',
      { MAIL_DRIVER: 'resend', RESEND_API_KEY: 're_test_key' },
      ResendMailTransport,
    ],
    [
      'ses',
      { MAIL_DRIVER: 'ses', AWS_REGION: 'eu-central-1' },
      SesMailTransport,
    ],
    [
      'smtp',
      { MAIL_DRIVER: 'smtp', SMTP_HOST: 'smtp.example.com' },
      SmtpMailTransport,
    ],
  ])('MAIL_DRIVER=%s', (_driver, env, expected) => {
    it('binds the matching transport', async () => {
      const moduleRef = await bootWith({ ...LOG_ENV, ...env }, ConsumerModule);

      expect(moduleRef.get(MAIL_TRANSPORT, { strict: false })).toBeInstanceOf(
        expected,
      );

      await moduleRef.close();
    });
  });

  it('refuses to boot on a driver name with no transport', async () => {
    await expect(
      bootWith({ ...LOG_ENV, MAIL_DRIVER: 'sendgrid' }, ConsumerModule),
    ).rejects.toThrow(/MAIL_DRIVER must be one of: log, resend, ses, smtp/);
  });

  it('refuses to boot when the active driver is missing its credentials', async () => {
    await expect(
      bootWith({ ...LOG_ENV, MAIL_DRIVER: 'resend' }, ConsumerModule),
    ).rejects.toThrow(/RESEND_API_KEY/);
  });
});
