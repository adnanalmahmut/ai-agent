import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import mailConfig from '../../../../src/infrastructure/config/mail.config';

/**
 * The factory reads `process.env` when it is called, and `ConfigModule` calls
 * it during boot — so "does this throw" here is the same question as "does the
 * application start".
 */
describe('mailConfig', () => {
  const original = process.env;

  beforeEach(() => {
    process.env = { ...original };
    delete process.env.MAIL_DRIVER;
    delete process.env.MAIL_FROM_ADDRESS;
    delete process.env.MAIL_FROM_NAME;
    delete process.env.MAIL_LOG_WRITE_HTML;
  });

  afterEach(() => {
    process.env = original;
  });

  it('defaults to the log driver', () => {
    process.env.MAIL_FROM_ADDRESS = 'no-reply@example.com';

    expect(mailConfig()).toEqual({
      driver: 'log',
      from: { address: 'no-reply@example.com', name: 'API Service' },
      writeHtml: false,
    });
  });

  it('reads the sender identity', () => {
    process.env.MAIL_FROM_ADDRESS = 'hello@example.com';
    process.env.MAIL_FROM_NAME = 'Molham';

    expect(mailConfig().from).toEqual({
      address: 'hello@example.com',
      name: 'Molham',
    });
  });

  it('parses the development HTML dump flag', () => {
    process.env.MAIL_FROM_ADDRESS = 'no-reply@example.com';
    process.env.MAIL_LOG_WRITE_HTML = 'true';

    expect(mailConfig()).toMatchObject({ writeHtml: true });
  });

  describe('fail-fast', () => {
    it('rejects an unknown driver', () => {
      process.env.MAIL_FROM_ADDRESS = 'no-reply@example.com';
      process.env.MAIL_DRIVER = 'carrier-pigeon';

      expect(() => mailConfig()).toThrow(/MAIL_DRIVER must be one of/);
    });

    it('refuses to boot without a sender address', () => {
      expect(() => mailConfig()).toThrow();
    });

    it('refuses to boot with a malformed sender address', () => {
      process.env.MAIL_FROM_ADDRESS = 'not-an-email';

      expect(() => mailConfig()).toThrow();
    });
  });

  describe('resend driver', () => {
    beforeEach(() => {
      process.env.MAIL_FROM_ADDRESS = 'no-reply@example.com';
      process.env.MAIL_DRIVER = 'resend';
      delete process.env.RESEND_API_KEY;
      delete process.env.MAIL_TIMEOUT_MS;
    });

    it('reads the API key and applies a default timeout', () => {
      process.env.RESEND_API_KEY = 're_test_key';

      expect(mailConfig()).toEqual({
        driver: 'resend',
        from: { address: 'no-reply@example.com', name: 'API Service' },
        apiKey: 're_test_key',
        timeoutMs: 10_000,
      });
    });

    it('accepts an explicit timeout', () => {
      process.env.RESEND_API_KEY = 're_test_key';
      process.env.MAIL_TIMEOUT_MS = '2500';

      expect(mailConfig()).toMatchObject({ timeoutMs: 2500 });
    });

    it('refuses to boot without the API key', () => {
      expect(() => mailConfig()).toThrow(/RESEND_API_KEY/);
    });

    it('refuses to boot with an empty API key', () => {
      process.env.RESEND_API_KEY = '';

      expect(() => mailConfig()).toThrow(/RESEND_API_KEY/);
    });

    it('rejects an implausible timeout instead of silently clamping', () => {
      process.env.RESEND_API_KEY = 're_test_key';
      process.env.MAIL_TIMEOUT_MS = '5';

      expect(() => mailConfig()).toThrow();
    });
  });

  describe('ses driver', () => {
    beforeEach(() => {
      process.env.MAIL_FROM_ADDRESS = 'no-reply@example.com';
      process.env.MAIL_DRIVER = 'ses';
      for (const key of [
        'AWS_REGION',
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'AWS_SESSION_TOKEN',
      ]) {
        delete process.env[key];
      }
    });

    /**
     * The deployment shape we actually want: an IAM task role, no long-lived
     * keys anywhere in the environment.
     */
    it('needs only a region, leaving credentials to the AWS chain', () => {
      process.env.AWS_REGION = 'eu-central-1';

      expect(mailConfig()).toEqual({
        driver: 'ses',
        from: { address: 'no-reply@example.com', name: 'API Service' },
        region: 'eu-central-1',
        credentials: undefined,
        timeoutMs: 10_000,
      });
    });

    it('accepts an explicit static key pair', () => {
      process.env.AWS_REGION = 'eu-central-1';
      process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLE';
      process.env.AWS_SECRET_ACCESS_KEY = 'secret';

      expect(mailConfig()).toMatchObject({
        credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' },
      });
    });

    it('carries a session token for temporary credentials', () => {
      process.env.AWS_REGION = 'eu-central-1';
      process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLE';
      process.env.AWS_SECRET_ACCESS_KEY = 'secret';
      process.env.AWS_SESSION_TOKEN = 'token';

      expect(mailConfig()).toMatchObject({
        credentials: { sessionToken: 'token' },
      });
    });

    it('refuses to boot without a region', () => {
      expect(() => mailConfig()).toThrow(/AWS_REGION/);
    });

    /**
     * A key without its secret would otherwise fall through to the credential
     * chain and appear to work, masking the real misconfiguration.
     */
    it('rejects a half-configured key pair', () => {
      process.env.AWS_REGION = 'eu-central-1';
      process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLE';

      expect(() => mailConfig()).toThrow(/must be set together/);
    });
  });

  describe('smtp driver', () => {
    beforeEach(() => {
      process.env.MAIL_FROM_ADDRESS = 'no-reply@example.com';
      process.env.MAIL_DRIVER = 'smtp';
      for (const key of [
        'SMTP_HOST',
        'SMTP_PORT',
        'SMTP_SECURE',
        'SMTP_USER',
        'SMTP_PASSWORD',
      ]) {
        delete process.env[key];
      }
    });

    it('defaults to submission on port 587 without implicit TLS', () => {
      process.env.SMTP_HOST = 'smtp.example.com';

      expect(mailConfig()).toEqual({
        driver: 'smtp',
        from: { address: 'no-reply@example.com', name: 'API Service' },
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        auth: undefined,
        timeoutMs: 10_000,
      });
    });

    it('supports implicit TLS on 465', () => {
      process.env.SMTP_HOST = 'smtp.example.com';
      process.env.SMTP_PORT = '465';
      process.env.SMTP_SECURE = 'true';

      expect(mailConfig()).toMatchObject({ port: 465, secure: true });
    });

    it('configures authentication when both parts are present', () => {
      process.env.SMTP_HOST = 'smtp.example.com';
      process.env.SMTP_USER = 'mailer';
      process.env.SMTP_PASSWORD = 'secret';

      expect(mailConfig()).toMatchObject({
        auth: { user: 'mailer', password: 'secret' },
      });
    });

    /** Local relays such as MailHog and Mailpit accept anonymous submission. */
    it('allows an unauthenticated relay', () => {
      process.env.SMTP_HOST = 'localhost';
      process.env.SMTP_PORT = '1025';

      expect(mailConfig()).toMatchObject({ auth: undefined });
    });

    it('rejects a username with no password', () => {
      process.env.SMTP_HOST = 'smtp.example.com';
      process.env.SMTP_USER = 'mailer';

      expect(() => mailConfig()).toThrow(/must be set together/);
    });

    it('refuses to boot without a host', () => {
      expect(() => mailConfig()).toThrow(/SMTP_HOST/);
    });
  });

  /**
   * The reason the factory switches on the driver instead of parsing one flat
   * schema: whoever runs one provider must never be asked for another's
   * credentials — and a stale, broken block for an inactive provider must not
   * be able to stop the process from starting.
   */
  describe('inactive provider configuration', () => {
    const activeDriverBoots = (driver: string, env: Record<string, string>) => {
      process.env.MAIL_FROM_ADDRESS = 'no-reply@example.com';
      process.env.MAIL_DRIVER = driver;
      Object.assign(process.env, env);

      // Every *other* provider is configured with garbage.
      process.env.RESEND_API_KEY = driver === 'resend' ? 're_key' : '';
      process.env.AWS_REGION = driver === 'ses' ? 'eu-central-1' : '';
      process.env.SMTP_HOST = driver === 'smtp' ? 'smtp.example.com' : '';
      process.env.SMTP_USER = driver === 'smtp' ? '' : 'orphaned-user';

      expect(() => mailConfig()).not.toThrow();
      expect(mailConfig().driver).toBe(driver);
    };

    it('boots on log while every other provider is misconfigured', () => {
      activeDriverBoots('log', {});
    });

    it('boots on resend while SES and SMTP are misconfigured', () => {
      activeDriverBoots('resend', { RESEND_API_KEY: 're_key' });
    });

    it('boots on ses while Resend and SMTP are misconfigured', () => {
      activeDriverBoots('ses', { AWS_REGION: 'eu-central-1' });
    });

    it('boots on smtp while Resend and SES are misconfigured', () => {
      activeDriverBoots('smtp', { SMTP_HOST: 'smtp.example.com' });
    });
  });
});
