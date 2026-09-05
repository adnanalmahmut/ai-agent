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
        .send({ email: EMAIL, redirectTo: 'https://app.example.com/reset' });

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
  // Deliberately NOT asserted here: where following that link finally lands.
  // A caller-supplied callbackURL is currently honoured without being checked
  // against BETTER_AUTH_TRUSTED_ORIGINS, and the password-reset case carries
  // the token to that foreign origin. That is a pre-existing defect, recorded
  // in docs/exec-plans/restructuring-test-checklist.md. It is not fixed in
  // this change, and it must not be pinned as correct by a test.
  describe('security mail is addressed by configuration, not by the request', () => {
    const authOrigin = new URL(process.env.BETTER_AUTH_URL ?? '').origin;
    const FOREIGN = 'https://mail-link-probe.invalid/landing';

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
          callbackURL: FOREIGN,
        });
      expect(response.status).toBe(200);

      await transport.settle();
      expect(transport.last.meta.template).toBe('EMAIL_VERIFICATION');

      // The recipient is the account address, not anything the body offered.
      expect(transport.last.to).toBe(email);
      expect(new URL(linkFrom(transport.last.html)).origin).toBe(authOrigin);

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
        .send({ email, redirectTo: FOREIGN });
      expect(response.status).toBe(200);

      await transport.settle();
      expect(transport.last.meta.template).toBe('PASSWORD_RESET');
      expect(transport.last.to).toBe(email);
      expect(new URL(linkFrom(transport.last.html)).origin).toBe(authOrigin);

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
});
