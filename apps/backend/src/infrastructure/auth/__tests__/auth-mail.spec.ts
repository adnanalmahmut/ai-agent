import { beforeEach, describe, expect, it } from '@jest/globals';

import type { MailService } from '../../mail';
import type { MailJob } from '../../mail';
import { createAuthMailCallbacks, type AuthMailOptions } from '../auth-mail';

const RESET_TOKEN = 'SUPER_SECRET_RESET_TOKEN';

/** Captures the jobs the adapter produces without delivering anything. */
function recordingMail() {
  const jobs: MailJob[] = [];

  return {
    jobs,
    service: {
      dispatch: (job: MailJob) => void jobs.push(job),
    } as unknown as MailService,
    last: () => {
      const job = jobs.at(-1);
      if (!job) throw new Error('No mail job was dispatched');
      return job;
    },
  };
}

const request = (headers: Record<string, string>) => ({
  headers: new Headers(headers),
});

/**
 * Stands in for the invitee lookup. Keyed by address so a test can express
 * "this invitee has an account and prefers English" without a database.
 */
const preferences: Record<string, unknown> = {};

const options = (
  overrides: Partial<AuthMailOptions> = {},
): AuthMailOptions => ({
  resetPasswordExpiresInMinutes: 60,
  invitationExpiresInHours: 48,
  platformUrl: 'https://platform.example.com/platform',
  lookupPreferredLanguage: (email) =>
    Promise.resolve(preferences[email.toLowerCase()] ?? null),
  ...overrides,
});

describe('auth mail callbacks', () => {
  let mail: ReturnType<typeof recordingMail>;
  let callbacks: ReturnType<typeof createAuthMailCallbacks>;

  beforeEach(() => {
    for (const key of Object.keys(preferences)) delete preferences[key];
    mail = recordingMail();
    callbacks = createAuthMailCallbacks(mail.service, options());
  });

  const user = (overrides: Record<string, unknown> = {}) => ({
    email: 'recipient@example.com',
    name: 'Adnan',
    ...overrides,
  });

  describe('email verification', () => {
    it('builds a typed EMAIL_VERIFICATION job', async () => {
      await callbacks.sendVerificationEmail(
        {
          user: user(),
          url: 'https://api.example.com/api/auth/verify-email?token=abc',
          token: 'abc',
        },
        request({}),
      );

      expect(mail.last()).toEqual({
        template: 'EMAIL_VERIFICATION',
        locale: 'ar',
        to: 'recipient@example.com',
        variables: {
          name: 'Adnan',
          actionUrl: 'https://api.example.com/api/auth/verify-email?token=abc',
        },
      });
    });

    it('resolves immediately rather than waiting on delivery', async () => {
      await expect(
        callbacks.sendVerificationEmail(
          { user: user(), url: 'https://example.com', token: 'abc' },
          request({}),
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe('password reset', () => {
    it('builds a typed PASSWORD_RESET job carrying the real expiry', async () => {
      await callbacks.sendResetPassword(
        {
          user: user(),
          url: `https://api.example.com/api/auth/reset-password/${RESET_TOKEN}`,
          token: RESET_TOKEN,
        },
        request({}),
      );

      expect(mail.last()).toMatchObject({
        template: 'PASSWORD_RESET',
        to: 'recipient@example.com',
        variables: { expiresInMinutes: 60 },
      });
    });

    it('quotes the configured expiry rather than a hard-coded one', async () => {
      const custom = createAuthMailCallbacks(
        mail.service,
        options({ resetPasswordExpiresInMinutes: 15 }),
      );

      await custom.sendResetPassword(
        { user: user(), url: 'https://example.com', token: 't' },
        request({}),
      );

      expect(mail.last().variables).toMatchObject({ expiresInMinutes: 15 });
    });
  });

  describe('organization invitation', () => {
    const invitation = (overrides: Record<string, unknown> = {}) => ({
      id: 'inv_123',
      email: 'invitee@example.com',
      organization: { name: 'Acme' },
      inviter: { user: user({ email: 'owner@example.com', name: 'Owner' }) },
      ...overrides,
    });

    it('builds a typed ORGANIZATION_INVITATION job', async () => {
      await callbacks.sendInvitationEmail(invitation(), request({}));

      expect(mail.last()).toEqual({
        template: 'ORGANIZATION_INVITATION',
        locale: 'ar',
        to: 'invitee@example.com',
        variables: {
          inviterName: 'Owner',
          organizationName: 'Acme',
          actionUrl:
            'https://platform.example.com/platform/ar/organizations/accept-invitation?id=inv_123',
          expiresInHours: 48,
        },
      });
    });

    /**
     * Better Auth generates no invitation URL, so the origin comes from
     * configuration — never from a request header, which an attacker could
     * set to point the accept link at a host they control.
     */
    it('builds the accept URL from configuration, not from the request', async () => {
      const custom = createAuthMailCallbacks(
        mail.service,
        options({ platformUrl: 'https://other.example.com/platform' }),
      );

      await custom.sendInvitationEmail(
        invitation(),
        request({
          host: 'evil.example.com',
          origin: 'https://evil.example.com',
        }),
      );

      expect(mail.last().variables).toMatchObject({
        actionUrl:
          'https://other.example.com/platform/ar/organizations/accept-invitation?id=inv_123',
      });
    });

    it('escapes an invitation id into the query string', async () => {
      await callbacks.sendInvitationEmail(
        invitation({ id: 'a b&c' }),
        request({}),
      );

      expect(mail.last().variables).toMatchObject({
        actionUrl:
          'https://platform.example.com/platform/ar/organizations/accept-invitation?id=a%20b%26c',
      });
    });

    it("uses the invitee's saved preference when they already have an account", async () => {
      preferences['invitee@example.com'] = 'en';

      await callbacks.sendInvitationEmail(invitation(), request({}));

      expect(mail.last().locale).toBe('en');
    });

    /**
     * The single most important assertion in this block. `X-App-Locale` on the
     * request belongs to the *inviter*; letting it win would mean an
     * Arabic-speaking admin overrides the saved English preference of the
     * person who actually receives the mail.
     */
    it("does not let the inviter's X-App-Locale override the invitee's preference", async () => {
      preferences['invitee@example.com'] = 'en';

      await callbacks.sendInvitationEmail(
        invitation(),
        request({ 'x-app-locale': 'ar' }),
      );

      expect(mail.last().locale).toBe('en');
    });

    it("falls back to the inviter's request locale for an unknown invitee", async () => {
      await callbacks.sendInvitationEmail(
        invitation(),
        request({ 'accept-language': 'en' }),
      );

      expect(mail.last().locale).toBe('en');
    });

    it('falls back to Arabic when nothing is known', async () => {
      await callbacks.sendInvitationEmail(invitation(), request({}));

      expect(mail.last().locale).toBe('ar');
    });

    it('ignores an unsupported stored preference and continues the chain', async () => {
      preferences['invitee@example.com'] = 'klingon';

      await callbacks.sendInvitationEmail(
        invitation(),
        request({ cookie: 'APP_LOCALE=en' }),
      );

      expect(mail.last().locale).toBe('en');
    });

    it('falls back to the inviter address when the inviter has no name', async () => {
      await callbacks.sendInvitationEmail(
        invitation({
          inviter: { user: user({ email: 'owner@example.com', name: null }) },
        }),
        request({}),
      );

      expect(mail.last().variables).toMatchObject({
        inviterName: 'owner@example.com',
      });
    });
  });

  /**
   * The documented chain, applied at the moment the mail is created. Getting
   * the ordering wrong here is invisible in production: the email simply
   * arrives in the wrong language.
   */
  describe('locale precedence', () => {
    const send = async (
      userOverrides: Record<string, unknown>,
      headers: Record<string, string>,
    ) => {
      await callbacks.sendVerificationEmail(
        { user: user(userOverrides), url: 'https://example.com', token: 't' },
        request(headers),
      );
      return mail.last().locale;
    };

    it('lets an explicit X-App-Locale beat the stored preference', async () => {
      await expect(
        send({ preferredLanguage: 'en' }, { 'x-app-locale': 'ar' }),
      ).resolves.toBe('ar');
    });

    it('uses the stored preference when no explicit header is sent', async () => {
      await expect(send({ preferredLanguage: 'en' }, {})).resolves.toBe('en');
    });

    it('lets the stored preference beat the cookie', async () => {
      await expect(
        send({ preferredLanguage: 'en' }, { cookie: 'APP_LOCALE=ar' }),
      ).resolves.toBe('en');
    });

    it('lets the stored preference beat accept-language', async () => {
      await expect(
        send({ preferredLanguage: 'en' }, { 'accept-language': 'ar' }),
      ).resolves.toBe('en');
    });

    it('falls back to the cookie for a user with no preference', async () => {
      await expect(send({}, { cookie: 'APP_LOCALE=en' })).resolves.toBe('en');
    });

    it('falls back to accept-language last', async () => {
      await expect(send({}, { 'accept-language': 'en' })).resolves.toBe('en');
    });

    it('defaults to Arabic when nothing is available', async () => {
      await expect(send({}, {})).resolves.toBe('ar');
    });

    it('ignores an unsupported header and continues the chain', async () => {
      await expect(
        send({ preferredLanguage: 'en' }, { 'x-app-locale': 'klingon' }),
      ).resolves.toBe('en');
    });

    it('ignores an unsupported stored preference', async () => {
      await expect(
        send({ preferredLanguage: 'klingon' }, { cookie: 'APP_LOCALE=en' }),
      ).resolves.toBe('en');
    });

    it('falls back to Arabic when every candidate is unsupported', async () => {
      await expect(
        send(
          { preferredLanguage: 'zh' },
          { 'x-app-locale': 'klingon', 'accept-language': 'de' },
        ),
      ).resolves.toBe('ar');
    });

    /**
     * Better Auth omits the request for server-initiated calls. That must
     * degrade to the account's own preference, not throw.
     */
    it('works when Better Auth supplies no request', async () => {
      await callbacks.sendVerificationEmail(
        {
          user: user({ preferredLanguage: 'en' }),
          url: 'https://example.com',
          token: 't',
        },
        undefined,
      );

      expect(mail.last().locale).toBe('en');
    });
  });

  it('falls back to the address when the account has no name', async () => {
    await callbacks.sendVerificationEmail(
      { user: user({ name: '  ' }), url: 'https://example.com', token: 't' },
      request({}),
    );

    expect(mail.last().variables).toMatchObject({
      name: 'recipient@example.com',
    });
  });
});
