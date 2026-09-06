import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  Body,
  Controller,
  Get,
  type INestApplication,
  Post,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  AllowAnonymous,
  OptionalAuth,
  Session,
  type UserSession,
} from '@thallesp/nestjs-better-auth';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { z } from 'zod';

import { AppModule } from '../../../src/api/app.module';
import { createZodDto } from '../../../src/infrastructure/http';
import { MAIL_TRANSPORT } from '../../../src/infrastructure/mail/mail-transport';
import type { MailTransport } from '../../../src/infrastructure/mail/mail-transport';
import type {
  MailDeliveryResult,
  OutboundMail,
} from '../../../src/infrastructure/mail/mail.types';
import { PrismaService } from '../../../src/infrastructure/database';
import { trustedBrowserOrigin } from '../../support/auth-harness';

const SENTINELS = [
  'LEAKY_RESEND_KEY',
  'LEAKY_AWS_SECRET',
  'LEAKY_SMTP_PASSWORD',
];

class CapturingTransport implements MailTransport {
  readonly sent: OutboundMail[] = [];
  failure: Error | undefined;

  send(mail: OutboundMail): Promise<MailDeliveryResult> {
    this.sent.push(mail);
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve({ provider: 'log', messageId: 'e2e' });
  }

  reset(): void {
    this.sent.length = 0;
    this.failure = undefined;
  }

  get last(): OutboundMail {
    const mail = this.sent.at(-1);
    if (!mail) throw new Error('No mail was dispatched');
    return mail;
  }

  async settle(): Promise<void> {
    for (let i = 0; i < 10 && this.sent.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

const signUpSchema = z.object({
  email: z.email(),
  age: z.coerce.number().int(),
});
class SignUpDto extends createZodDto(signUpSchema) {}

@Controller('e2e')
class ProbeController {
  @Post('echo')
  @AllowAnonymous()
  echo(@Body() body: SignUpDto) {
    return { received: body };
  }

  @Get('protected')
  protectedRoute(@Session() session: UserSession) {
    return { email: session.user.email };
  }

  @Get('anonymous')
  @AllowAnonymous()
  anonymous() {
    return { ok: true };
  }

  @Get('optional')
  @OptionalAuth()
  optional(@Session() session: UserSession | undefined) {
    return { authenticated: Boolean(session?.user) };
  }
}

type ErrorBody = { statusCode: number; errorCode: string; message: string };

const errorBody = (response: Response): ErrorBody => {
  const b = response.body as Record<string, any>;
  if (b && typeof b === 'object' && b.error && typeof b.error === 'object') {
    return {
      statusCode: response.status,
      errorCode: b.error.code,
      message: b.error.message,
    };
  }
  return b as ErrorBody;
};

const EMAIL = `e2e-${Date.now()}@example.com`;
const PASSWORD = 'super-secret-password';

describe('Better Auth (e2e)', () => {
  let app: INestApplication;
  let server: App;
  let transport: CapturingTransport;
  let prisma: PrismaService;
  const logged: string[] = [];

  beforeAll(async () => {
    transport = new CapturingTransport();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ProbeController],
    })
      .overrideProvider(MAIL_TRANSPORT)
      .useValue(transport)
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });

    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      stream.write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
        logged.push(String(chunk));
        return write(chunk, ...(rest as []));
      };
    }

    await app.init();
    server = app.getHttpServer() as App;
    prisma = app.get(PrismaService);

    await prisma.user.deleteMany({ where: { email: EMAIL } });
  });

  afterAll(async () => {
    await prisma?.user.deleteMany({ where: { email: EMAIL } });
    await app?.close();
  });

  describe('body parsing', () => {
    it('parses a normal JSON POST on an application route', async () => {
      const response = await request(server)
        .post('/e2e/echo')
        .send({ email: 'user@example.com', age: '30' });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        success: true,
        data: {
          received: { email: 'user@example.com', age: 30 },
        },
      });
    });

    it('still runs Zod validation and localizes the failure', async () => {
      const response = await request(server)
        .post('/e2e/echo')
        .set('X-App-Locale', 'en')
        .send({ email: 'not-an-email', age: 'abc' });

      expect(response.status).toBe(400);
      expect(errorBody(response).errorCode).toBe('VALIDATION_ERROR');
    });
  });

  describe('guard policy', () => {
    it('protects routes by default', async () => {
      const response = await request(server).get('/e2e/protected');

      expect(response.status).toBe(401);
    });

    it('allows an explicitly anonymous route', async () => {
      await request(server).get('/e2e/anonymous').expect(200);
    });

    it('allows an optional-auth route without a session', async () => {
      const response = await request(server).get('/e2e/optional');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        data: { authenticated: false },
      });
    });

    describe('localized 401 without an I18nContext', () => {
      it('answers in English when asked to', async () => {
        const response = await request(server)
          .get('/e2e/protected')
          .set('X-App-Locale', 'en');

        expect(response.status).toBe(401);
        expect(errorBody(response).message).toBe(
          'You must be signed in to continue',
        );
      });

      it('answers in Arabic when asked to', async () => {
        const response = await request(server)
          .get('/e2e/protected')
          .set('X-App-Locale', 'ar');

        expect(errorBody(response).message).toBe('يجب تسجيل الدخول للمتابعة');
      });

      it('honours accept-language when no explicit header is sent', async () => {
        const response = await request(server)
          .get('/e2e/protected')
          .set('Accept-Language', 'en');

        expect(errorBody(response).message).toBe(
          'You must be signed in to continue',
        );
      });

      it('falls back to Arabic for an unsupported locale', async () => {
        const response = await request(server)
          .get('/e2e/protected')
          .set('X-App-Locale', 'klingon');

        expect(errorBody(response).message).toBe('يجب تسجيل الدخول للمتابعة');
      });
    });
  });

  describe('sign-up → verify → sign-in → reset', () => {
    let verificationUrl: string;
    let sessionCookie: string;

    it('signs up and dispatches a verification email', async () => {
      transport.reset();

      const response = await request(server)
        .post('/api/auth/sign-up/email')
        .set('X-App-Locale', 'en')
        .send({ name: 'E2E User', email: EMAIL, password: PASSWORD });

      expect(response.status).toBe(200);

      await transport.settle();
      expect(transport.last.meta.template).toBe('EMAIL_VERIFICATION');
      expect(transport.last.to).toBe(EMAIL);

      const match = /href="([^"]*verify-email[^"]*)"/.exec(transport.last.html);
      verificationUrl = (match?.[1] ?? '').replace(/&amp;/g, '&');
      expect(verificationUrl).toContain('token=');
    });

    it('resolves the outbound locale from the request that triggered it', () => {
      expect(transport.last.meta.locale).toBe('en');
      expect(transport.last.html).toContain('<html lang="en" dir="ltr">');
    });

    it('refuses sign-in before the address is verified', async () => {
      const response = await request(server)
        .post('/api/auth/sign-in/email')
        .send({ email: EMAIL, password: PASSWORD });

      expect(response.status).toBe(403);
    });

    it('verifies the address by following the emailed link', async () => {
      const path = verificationUrl.slice(verificationUrl.indexOf('/api/auth'));

      const response = await request(server).get(path).redirects(0);

      expect([200, 302]).toContain(response.status);

      const user = await prisma.user.findFirst({ where: { email: EMAIL } });
      expect(user?.emailVerified).toBe(true);
    });

    it('signs in after verification and issues a session cookie', async () => {
      const response = await request(server)
        .post('/api/auth/sign-in/email')
        .send({ email: EMAIL, password: PASSWORD });

      expect(response.status).toBe(200);

      const cookies = response.headers['set-cookie'] as unknown as string[];
      sessionCookie = (cookies ?? []).join('; ');
      expect(sessionCookie).toContain('__Host-session');
    });

    it('admits the session to a protected application route', async () => {
      const response = await request(server)
        .get('/e2e/protected')
        .set('Cookie', sessionCookie);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        data: { email: EMAIL },
      });
    });

    it('reports the session on an optional-auth route', async () => {
      const response = await request(server)
        .get('/e2e/optional')
        .set('Cookie', sessionCookie);

      expect(response.body).toMatchObject({
        success: true,
        data: { authenticated: true },
      });
    });

    it('dispatches a password-reset email on request', async () => {
      transport.reset();

      const response = await request(server)
        .post('/api/auth/request-password-reset')
        .set('X-App-Locale', 'ar')
        .send({
          email: EMAIL,
          redirectTo: `${trustedBrowserOrigin}/platform/ar/reset-password`,
        });

      expect(response.status).toBe(200);

      await transport.settle();
      expect(transport.last.meta.template).toBe('PASSWORD_RESET');
      expect(transport.last.meta.locale).toBe('ar');
      expect(transport.last.html).toContain('<html lang="ar" dir="rtl">');
    });

    it('completes the reset with the emailed token', async () => {
      const match = /reset-password\/([A-Za-z0-9_-]+)/.exec(
        transport.last.html,
      );
      const token = match?.[1];
      expect(token).toBeTruthy();

      const response = await request(server)
        .post('/api/auth/reset-password')
        .send({ newPassword: 'a-brand-new-password', token });

      expect(response.status).toBe(200);

      await request(server)
        .post('/api/auth/sign-in/email')
        .send({ email: EMAIL, password: 'a-brand-new-password' })
        .expect(200);
    });
  });

  describe('stored language preference', () => {
    beforeAll(async () => {
      await prisma.user.updateMany({
        where: { email: EMAIL },
        data: { preferredLanguage: 'en' },
      });
    });

    it('uses the stored preference when no explicit header is sent', async () => {
      transport.reset();

      await request(server)
        .post('/api/auth/request-password-reset')
        .send({ email: EMAIL });

      await transport.settle();
      expect(transport.last.meta.locale).toBe('en');
    });

    it('lets an explicit X-App-Locale beat the stored preference', async () => {
      transport.reset();

      await request(server)
        .post('/api/auth/request-password-reset')
        .set('X-App-Locale', 'ar')
        .send({ email: EMAIL });

      await transport.settle();
      expect(transport.last.meta.locale).toBe('ar');
    });

    it('lets the stored preference beat the APP_LOCALE cookie', async () => {
      transport.reset();

      await request(server)
        .post('/api/auth/request-password-reset')
        .set('Cookie', 'APP_LOCALE=ar')
        .set('Origin', trustedBrowserOrigin)
        .send({ email: EMAIL });

      await transport.settle();
      expect(transport.last.meta.locale).toBe('en');
    });

    it('ignores an unsupported header and keeps the stored preference', async () => {
      transport.reset();

      await request(server)
        .post('/api/auth/request-password-reset')
        .set('X-App-Locale', 'klingon')
        .send({ email: EMAIL });

      await transport.settle();
      expect(transport.last.meta.locale).toBe('en');
    });
  });

  describe('mail failure isolation', () => {
    it('does not fail the auth request when delivery throws', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);

      try {
        transport.reset();
        transport.failure = new Error('Provider unavailable');

        const response = await request(server)
          .post('/api/auth/request-password-reset')
          .send({ email: EMAIL });

        expect(response.status).toBe(200);

        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
        transport.failure = undefined;
      }
    });
  });

  describe('preferredLanguage validation', () => {
    it('accepts valid supported locales on update', async () => {
      const email = 'pref-valid@example.com';
      await request(server).post('/api/auth/sign-up/email').send({
        email,
        password: PASSWORD,
        name: 'Pref Valid',
      });

      await prisma.user.update({
        where: { email },
        data: { emailVerified: true },
      });

      const signInRes = await request(server)
        .post('/api/auth/sign-in/email')
        .send({ email, password: PASSWORD });

      const cookie = signInRes.headers['set-cookie'] as unknown as string[];

      const updateRes = await request(server)
        .post('/api/auth/update-user')
        .set('Cookie', cookie ?? [])
        .set('Origin', trustedBrowserOrigin)
        .send({ preferredLanguage: 'ar' });

      expect(updateRes.status).toBe(200);

      const dbUser = await prisma.user.findUnique({
        where: { email },
        select: { preferredLanguage: true },
      });
      expect(dbUser?.preferredLanguage).toBe('ar');
    });

    it('rejects unsupported preferred language on update', async () => {
      const email = 'pref-invalid@example.com';
      await request(server).post('/api/auth/sign-up/email').send({
        email,
        password: PASSWORD,
        name: 'Pref Invalid',
      });

      await prisma.user.update({
        where: { email },
        data: { emailVerified: true },
      });

      const signInRes = await request(server)
        .post('/api/auth/sign-in/email')
        .send({ email, password: PASSWORD });

      const cookie = signInRes.headers['set-cookie'] as unknown as string[];

      const updateRes = await request(server)
        .post('/api/auth/update-user')
        .set('Cookie', cookie ?? [])
        .set('Origin', trustedBrowserOrigin)
        .send({ preferredLanguage: 'klingon' });

      expect(updateRes.status).toBe(400);
    });

    it('accepts preferredLanguage=ar during sign-up', async () => {
      const res = await request(server).post('/api/auth/sign-up/email').send({
        email: 'signup-lang-ar@example.com',
        password: PASSWORD,
        name: 'Signup AR',
        preferredLanguage: 'ar',
      });

      expect(res.status).toBe(200);

      const dbUser = await prisma.user.findUnique({
        where: { email: 'signup-lang-ar@example.com' },
        select: { preferredLanguage: true },
      });
      expect(dbUser?.preferredLanguage).toBe('ar');
    });

    it('rejects preferredLanguage=klingon during sign-up', async () => {
      const res = await request(server).post('/api/auth/sign-up/email').send({
        email: 'signup-lang-klingon@example.com',
        password: PASSWORD,
        name: 'Signup Klingon',
        preferredLanguage: 'klingon',
      });

      expect(res.status).toBe(400);

      const dbUser = await prisma.user.findUnique({
        where: { email: 'signup-lang-klingon@example.com' },
      });
      expect(dbUser).toBeNull();
    });
  });

  describe('log safety', () => {
    it('never writes an auth token or action URL to the logs', () => {
      const output = logged.join('');

      expect(output).not.toContain('verify-email?token=');
      expect(output).not.toContain('reset-password/');

      for (const sentinel of SENTINELS) {
        expect(output).not.toContain(sentinel);
      }
    });

    it('never writes the recipient address in full', () => {
      expect(logged.join('')).not.toContain(EMAIL);
    });
  });
  // Security mail is due to move onto its own Control Plane worker and queue.
  // What must survive that move is pinned here: the address the mail goes to,
  // and the origin of the link inside it, are decided by server configuration
  // and never by the request that triggered the send.
  //
  // Where following that link lands is asserted by the block after this one.
  describe('security mail is addressed by configuration, not by the request', () => {
    const authOrigin = new URL(process.env.BETTER_AUTH_URL ?? '').origin;

    // A destination the caller is entitled to name — it sits on a trusted
    // origin, so Better Auth's own check lets it through — but that the product
    // never chose. It is the case that isolates the second layer: what the
    // server decides, rather than what the trusted-origin list permits. A
    // foreign destination is refused upstream instead, covered further down.
    const CALLER_CHOSEN = `${trustedBrowserOrigin}/platform/en/somewhere-else`;

    const linkFrom = (html: string): string => {
      const match = /href="(https?:[^"]+)"/.exec(html);
      if (!match) throw new Error('the mail carried no absolute link');
      return match[1].replace(/&amp;/g, '&');
    };

    it('keeps the verification link on the configured auth origin', async () => {
      const email = `link-verify-${Date.now()}@example.com`;
      transport.reset();

      const response = await request(server)
        .post('/api/auth/sign-up/email')
        .send({
          name: 'Link Probe',
          email,
          password: PASSWORD,
          callbackURL: CALLER_CHOSEN,
        });
      expect(response.status).toBe(200);

      await transport.settle();
      expect(transport.last.meta.template).toBe('EMAIL_VERIFICATION');

      // The recipient is the account address, not anything the body offered.
      expect(transport.last.to).toBe(email);

      const link = new URL(linkFrom(transport.last.html));
      expect(link.origin).toBe(authOrigin);
      // Trusted origin or not, the caller's destination is discarded.
      expect(link.searchParams.get('callbackURL')).not.toBe(CALLER_CHOSEN);

      await prisma.user.deleteMany({ where: { email } });
    });

    it('keeps the password-reset link on the configured auth origin', async () => {
      const email = `link-reset-${Date.now()}@example.com`;
      await request(server)
        .post('/api/auth/sign-up/email')
        .send({ name: 'Link Probe', email, password: PASSWORD });
      await transport.settle();

      transport.reset();
      const response = await request(server)
        .post('/api/auth/request-password-reset')
        .send({ email, redirectTo: CALLER_CHOSEN });
      expect(response.status).toBe(200);

      await transport.settle();
      expect(transport.last.meta.template).toBe('PASSWORD_RESET');
      expect(transport.last.to).toBe(email);

      const link = new URL(linkFrom(transport.last.html));
      expect(link.origin).toBe(authOrigin);
      expect(link.searchParams.get('callbackURL')).not.toBe(CALLER_CHOSEN);

      await prisma.user.deleteMany({ where: { email } });
    });

    it('sends nothing at all for an address that has no account', async () => {
      transport.reset();

      const response = await request(server)
        .post('/api/auth/request-password-reset')
        .send({ email: `absent-${Date.now()}@example.com` });

      // The answer must not distinguish a known address from an unknown one.
      expect(response.status).toBe(200);

      await transport.settle();
      expect(transport.sent).toEqual([]);
    });
  });

  // The companion to the block above: where following the mailed link finally
  // lands. The destination is built by the server from APP_PLATFORM_URL and a
  // known route, so a caller-supplied `callbackURL` / `redirectTo` cannot steer
  // it. That matters most for password reset, whose destination receives the
  // reset token as a query parameter.
  describe('security mail returns only to a server-decided destination', () => {
    const authOrigin = new URL(process.env.BETTER_AUTH_URL ?? '').origin;
    const platformUrl = process.env.APP_PLATFORM_URL ?? '';
    const platformOrigin = new URL(platformUrl).origin;
    const platformPath = new URL(platformUrl).pathname;

    // Every shape here is a way of naming a destination the product never
    // chose: a plainly foreign origin, a host that merely resembles the trusted
    // one, an authority hidden behind userinfo or a backslash, an encoded
    // origin, a scheme or port swap, and a non-http scheme.
    const ATTACKS: readonly [string, string][] = [
      ['a plainly foreign origin', 'https://attacker.example/steal'],
      [
        'a host that only ends with the trusted one',
        'http://localhost:3001.attacker.example/steal',
      ],
      [
        'userinfo hiding the real host',
        'http://localhost:3001@attacker.example/steal',
      ],
      ['a protocol-relative authority', '//attacker.example/steal'],
      ['a backslash-confused authority', 'https:/\\attacker.example/steal'],
      ['a foreign port on the trusted host', 'http://localhost:4444/steal'],
      [
        'a scheme swap on the trusted host',
        'https://localhost:3001/platform/en/reset-password',
      ],
      [
        'a percent-encoded foreign origin',
        'https%3A%2F%2Fattacker.example%2Fsteal',
      ],
      [
        'a double-encoded foreign origin',
        'https%253A%252F%252Fattacker.example%252Fsteal',
      ],
      ['a non-http scheme', 'javascript:fetch("https://attacker.example")'],
      [
        'a newline-smuggled origin',
        'https://localhost:3001/ok\nhttps://attacker.example/steal',
      ],
    ];

    const linkFrom = (html: string): string => {
      const match = /href="(https?:[^"]+)"/.exec(html);
      if (!match) throw new Error('the mail carried no absolute link');
      return match[1].replace(/&amp;/g, '&');
    };

    // Follow the mailed link exactly as a mail client would, but stop at the
    // first hop: the redirect itself is the thing under test.
    const follow = (link: string) =>
      request(server).get(link.slice(authOrigin.length)).redirects(0);

    const users: string[] = [];
    const register = async (label: string): Promise<string> => {
      const email = `return-${label}-${Date.now()}@example.com`;
      users.push(email);
      await request(server)
        .post('/api/auth/sign-up/email')
        .set('X-App-Locale', 'en')
        .send({ name: 'Return Probe', email, password: PASSWORD });
      await transport.settle();
      return email;
    };

    afterAll(async () => {
      for (const email of users) {
        await prisma.user.deleteMany({ where: { email } });
      }
    });

    describe('password reset', () => {
      let email: string;

      beforeAll(async () => {
        email = await register('reset');

        // Sign-in below requires a verified mailbox, so walk the real
        // verification link rather than writing the flag straight to the row.
        transport.reset();
        await request(server)
          .post('/api/auth/send-verification-email')
          .set('X-App-Locale', 'en')
          .send({ email });
        await transport.settle();
        await follow(linkFrom(transport.last.html));
      });

      it.each(ATTACKS)(
        'ignores %s offered as redirectTo',
        async (_label, destination) => {
          transport.reset();

          const response = await request(server)
            .post('/api/auth/request-password-reset')
            .set('X-App-Locale', 'en')
            .send({ email, redirectTo: destination });

          // Either the request is refused outright or it is honoured with the
          // server's own destination. What must never happen is a mailed link
          // that carries the token anywhere the caller named.
          if (response.status !== 200) {
            expect(response.status).toBe(403);
            return;
          }

          await transport.settle();
          const mail = transport.last;

          expect(mail.to).toBe(email);
          expect(mail.html).not.toContain('attacker.example');

          const link = linkFrom(mail.html);
          expect(new URL(link).origin).toBe(authOrigin);
          expect(new URL(link).searchParams.get('callbackURL')).toBe(
            `${platformUrl}/en/reset-password`,
          );

          const followed = await follow(link);
          expect(followed.status).toBe(302);

          const location = new URL(followed.headers.location);
          expect(location.origin).toBe(platformOrigin);
          expect(location.pathname).toBe(`${platformPath}/en/reset-password`);

          // The token is delivered, and only to the server's own destination.
          expect(location.searchParams.get('token')).toBeTruthy();
          expect(followed.headers.location).not.toContain('attacker.example');
        },
      );

      it('still completes a legitimate reset end to end', async () => {
        transport.reset();

        await request(server)
          .post('/api/auth/request-password-reset')
          .set('X-App-Locale', 'en')
          .send({ email, redirectTo: `${platformUrl}/en/reset-password` })
          .expect(200);

        await transport.settle();
        const followed = await follow(linkFrom(transport.last.html));
        expect(followed.status).toBe(302);

        const token = new URL(followed.headers.location).searchParams.get(
          'token',
        );
        expect(token).toBeTruthy();

        await request(server)
          .post('/api/auth/reset-password')
          .send({ newPassword: 'another-brand-new-password', token })
          .expect(200);

        await request(server)
          .post('/api/auth/sign-in/email')
          .send({ email, password: 'another-brand-new-password' })
          .expect(200);
      });
    });

    describe('email verification', () => {
      it('ignores a foreign callbackURL offered at sign-up', async () => {
        const email = `return-signup-${Date.now()}@example.com`;
        users.push(email);
        transport.reset();

        const response = await request(server)
          .post('/api/auth/sign-up/email')
          .set('X-App-Locale', 'en')
          .send({
            name: 'Return Probe',
            email,
            password: PASSWORD,
            callbackURL: 'https://attacker.example/steal',
          });

        if (response.status !== 200) {
          expect(response.status).toBe(403);
          return;
        }

        await transport.settle();
        const mail = transport.last;

        expect(mail.meta.template).toBe('EMAIL_VERIFICATION');
        expect(mail.to).toBe(email);
        expect(mail.html).not.toContain('attacker.example');

        const link = linkFrom(mail.html);
        expect(new URL(link).origin).toBe(authOrigin);

        const followed = await follow(link);
        expect(followed.status).toBe(302);
        expect(followed.headers.location).toBe(
          `${platformUrl}/en/verify-email?status=verified`,
        );

        // Verification still did its job on the way through.
        const user = await prisma.user.findUnique({ where: { email } });
        expect(user?.emailVerified).toBe(true);
      });

      it.each(ATTACKS)(
        'ignores %s offered to a resend',
        async (_label, destination) => {
          const email = await register('resend');
          transport.reset();

          const response = await request(server)
            .post('/api/auth/send-verification-email')
            .set('X-App-Locale', 'en')
            .send({ email, callbackURL: destination });

          if (response.status !== 200) {
            expect(response.status).toBe(403);
            return;
          }

          await transport.settle();
          const mail = transport.last;

          expect(mail.to).toBe(email);
          expect(mail.html).not.toContain('attacker.example');

          const link = linkFrom(mail.html);
          expect(new URL(link).origin).toBe(authOrigin);

          const followed = await follow(link);
          expect(followed.status).toBe(302);
          expect(followed.headers.location).toBe(
            `${platformUrl}/en/verify-email?status=verified`,
          );
        },
      );
    });

    it('takes the destination language from the server, not the request', async () => {
      const email = await register('locale');
      await prisma.user.updateMany({
        where: { email },
        data: { preferredLanguage: 'ar' },
      });
      transport.reset();

      await request(server)
        .post('/api/auth/request-password-reset')
        .send({
          email,
          redirectTo: `${trustedBrowserOrigin}/platform/en/somewhere-else`,
        })
        .expect(200);

      await transport.settle();
      expect(transport.last.meta.locale).toBe('ar');

      const followed = await follow(linkFrom(transport.last.html));
      expect(followed.headers.location).toContain(
        `${platformUrl}/ar/reset-password`,
      );
    });
  });
});
