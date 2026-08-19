import type { INestApplication, Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../../src/app.module';
import { MAIL_TRANSPORT } from '../../src/core/mail/mail-transport';
import type { MailTransport } from '../../src/core/mail/mail-transport';
import type {
  MailDeliveryResult,
  OutboundMail,
} from '../../src/core/mail/mail.types';
import { PrismaService } from '../../src/database';

/**
 * Shared boot for the authorization e2e suites.
 *
 * Every suite runs the *real* `AppModule` with `bodyParser: false`, so what is
 * exercised is the production wiring: the global `AuthGuard`, the Better Auth
 * plugins, the archived-organization hook, the Zod pipe and the localized
 * exception filter. Only the mail transport is substituted, and only so that
 * nothing leaves the process.
 */

/** Substitutes for the configured driver; the renderer and locale logic are real. */
export class CapturingTransport implements MailTransport {
  readonly sent: OutboundMail[] = [];

  send(mail: OutboundMail): Promise<MailDeliveryResult> {
    this.sent.push(mail);
    return Promise.resolve({ provider: 'log', messageId: 'e2e' });
  }

  reset(): void {
    this.sent.length = 0;
  }

  get last(): OutboundMail {
    const mail = this.sent.at(-1);
    if (!mail) throw new Error('No mail was dispatched');
    return mail;
  }

  ofTemplate(template: string): OutboundMail[] {
    return this.sent.filter((mail) => mail.meta.template === template);
  }

  /** The mail layer is fire-and-forget by design; give `dispatch` a tick. */
  async settle(expected = 1): Promise<void> {
    for (let i = 0; i < 20 && this.sent.length < expected; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

export type Harness = {
  app: INestApplication;
  server: App;
  prisma: PrismaService;
  transport: CapturingTransport;
  close: () => Promise<void>;
};

export async function createHarness(
  options: {
    controllers?: Type<unknown>[];
    /**
     * Boots with the production global prefix.
     *
     * Off by default so every existing suite keeps addressing routes the way
     * it always has. The one suite that turns it on is there to prove the
     * prefix does what `main.ts` claims — including that it leaves Better
     * Auth alone.
     */
    globalPrefix?: string;
  } = {},
): Promise<Harness> {
  const transport = new CapturingTransport();

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: options.controllers ?? [],
  })
    .overrideProvider(MAIL_TRANSPORT)
    .useValue(transport)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });

  if (options.globalPrefix) app.setGlobalPrefix(options.globalPrefix);

  await app.init();

  const prisma = app.get(PrismaService);

  return {
    app,
    server: app.getHttpServer() as App,
    prisma,
    transport,
    close: async () => {
      await app.close();
    },
  };
}

export type TestUser = {
  id: string;
  email: string;
  password: string;
  cookie: string;
};

let sequence = 0;
const unique = () => `${Date.now().toString(36)}-${(sequence += 1)}`;

const PASSWORD = 'harness-password-01';

/**
 * Creates a verified, signed-in account.
 *
 * Sign-up goes through the real endpoint so the plugin's own hooks run — the
 * admin plugin assigns `defaultRole` in `user.create.before`, and asserting on
 * that is one of the things these suites exist to do. Verification is applied
 * directly, because clicking the emailed link is covered by the pre-existing
 * `e2e/auth.e2e-spec.ts` and repeating it here would only slow the suite down.
 */
export async function createUser(
  harness: Harness,
  options: { role?: string; signIn?: boolean; email?: string } = {},
): Promise<TestUser> {
  const email = options.email ?? `e2e-${unique()}@example.com`;

  await request(harness.server)
    .post('/api/auth/sign-up/email')
    .send({ email, password: PASSWORD, name: 'Harness User' })
    .expect(200);

  const user = await harness.prisma.user.update({
    where: { email },
    data: {
      emailVerified: true,
      ...(options.role === undefined ? {} : { role: options.role }),
    },
    select: { id: true },
  });

  const cookie =
    options.signIn === false ? '' : await signIn(harness, email, PASSWORD);

  return { id: user.id, email, password: PASSWORD, cookie };
}

/** Returns the session cookie header, or throws with the server's reason. */
export async function signIn(
  harness: Harness,
  email: string,
  password = PASSWORD,
): Promise<string> {
  const response = await request(harness.server)
    .post('/api/auth/sign-in/email')
    .send({ email, password });

  if (response.status !== 200) {
    throw new Error(
      `sign-in failed with ${response.status}: ${JSON.stringify(response.body)}`,
    );
  }

  return cookieOf(response);
}

/** Attempts a sign-in and reports the raw response, for the denial cases. */
export function trySignIn(
  harness: Harness,
  email: string,
  password = PASSWORD,
): Promise<Response> {
  return request(harness.server)
    .post('/api/auth/sign-in/email')
    .send({ email, password });
}

export function cookieOf(response: Response): string {
  // Supertest types this header as `any`; narrow it once here so callers get a
  // plain string and the unsafe access lives in one place.
  const header: unknown = response.headers['set-cookie'];
  const cookies: string[] = Array.isArray(header)
    ? (header as string[])
    : typeof header === 'string'
      ? [header]
      : [];

  return cookies.map((cookie) => cookie.split(';')[0] ?? '').join('; ');
}

export type ErrorBody = {
  statusCode: number;
  errorCode: string;
  message: string;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export const errorBody = (response: Response): ErrorBody => {
  const b = response.body as Record<string, any>;
  if (b && typeof b === 'object' && b.error && typeof b.error === 'object') {
    return {
      statusCode: response.status,
      errorCode: b.error.code,
      message: b.error.message,
      error: b.error,
    };
  }
  return b as ErrorBody;
};

/** Signed-in request helpers, so suites read as intent rather than plumbing. */
export const as = (harness: Harness, user: Pick<TestUser, 'cookie'>) => ({
  get: (path: string) =>
    request(harness.server).get(path).set('Cookie', user.cookie),
  post: (path: string, body?: unknown) =>
    request(harness.server)
      .post(path)
      .set('Cookie', user.cookie)
      .send(body ?? {}),
});
