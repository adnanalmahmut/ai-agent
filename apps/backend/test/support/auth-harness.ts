import type { INestApplication, Type } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../../src/api/app.module';
import { httpConfig } from '../../src/infrastructure/config';
import {
  GeoIpService,
  type GeoIpLocation,
} from '../../src/infrastructure/geoip';
import { configureTrustedProxy } from '../../src/infrastructure/http';
import { AGENT_DEFINITIONS } from '../../src/ai/agents/agent-definition.registry';
import type { AgentDefinition } from '../../src/ai/agents/agent.types';
import { EMBEDDING_PORT } from '../../src/features/knowledge';
import { MAIL_TRANSPORT } from '../../src/infrastructure/mail/mail-transport';
import type { MailTransport } from '../../src/infrastructure/mail/mail-transport';
import type {
  MailDeliveryResult,
  OutboundMail,
} from '../../src/infrastructure/mail/mail.types';
import { PrismaService } from '../../src/infrastructure/database';

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
    globalPrefix?: string;
    geoIp?: {
      lookup: (ipAddress: string | null | undefined) => Promise<GeoIpLocation>;
    };
    embeddings?: {
      model: string;
      dimensions: number;
      maxBatch: number;
      embed: (texts: readonly string[]) => Promise<number[][]>;
    };
    definitions?: readonly AgentDefinition[];
  } = {},
): Promise<Harness> {
  const transport = new CapturingTransport();

  let builder = Test.createTestingModule({
    imports: [AppModule],
    controllers: options.controllers ?? [],
  })
    .overrideProvider(MAIL_TRANSPORT)
    .useValue(transport);

  if (options.geoIp) {
    builder = builder.overrideProvider(GeoIpService).useValue(options.geoIp);
  }

  if (options.embeddings) {
    builder = builder
      .overrideProvider(EMBEDDING_PORT)
      .useValue(options.embeddings);
  }

  if (options.definitions) {
    builder = builder
      .overrideProvider(AGENT_DEFINITIONS)
      .useValue(options.definitions);
  }

  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });

  configureTrustedProxy(
    app,
    app.get<ConfigType<typeof httpConfig>>(httpConfig.KEY),
  );

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

// The origin a browser running the platform application would report. Taken
// from the same configuration the application trusts, so the harness cannot
// drift from `BETTER_AUTH_TRUSTED_ORIGINS` by hard-coding a string.
export const trustedBrowserOrigin = new URL(
  process.env.APP_PLATFORM_URL ?? 'http://localhost:3001/platform',
).origin;

// Requests made through `as()` stand for a signed-in browser, and a browser
// attaches `Origin` to every state-changing request it sends. Better Auth's
// origin check is pinned on in every environment, including tests, so omitting
// it here would model something no browser does. Tests that exist to pin the
// missing- or foreign-Origin behavior build their request directly instead of
// going through this helper.
export const as = (harness: Harness, user: Pick<TestUser, 'cookie'>) => ({
  get: (path: string) =>
    request(harness.server)
      .get(path)
      .set('Cookie', user.cookie)
      .set('Origin', trustedBrowserOrigin),
  post: (path: string, body?: unknown) =>
    request(harness.server)
      .post(path)
      .set('Cookie', user.cookie)
      .set('Origin', trustedBrowserOrigin)
      .send(body ?? {}),
  put: (path: string, body?: unknown) =>
    request(harness.server)
      .put(path)
      .set('Cookie', user.cookie)
      .set('Origin', trustedBrowserOrigin)
      .send(body ?? {}),
  del: (path: string) =>
    request(harness.server)
      .delete(path)
      .set('Cookie', user.cookie)
      .set('Origin', trustedBrowserOrigin),
});
