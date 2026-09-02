import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  type INestApplication,
  Post,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { z } from 'zod';

import { configurations } from '../../../src/infrastructure/config';
import { AppException } from '../../../src/core/errors';
import {
  createZodDto,
  HttpInfrastructureModule,
} from '../../../src/infrastructure/http';
import { AppI18nModule } from '../../../src/infrastructure/i18n';
import {
  MailModule,
  MailRendererService,
} from '../../../src/infrastructure/mail';

interface FieldErrorBody {
  field: string;
  code: string;
  message: string;
}

interface ErrorBody {
  success: boolean;
  statusCode: number;
  errorCode: string;
  message: string;
  errors?: FieldErrorBody[];
  timestamp: string;
}

const errorBody = (response: Response): ErrorBody => {
  const b = response.body as Record<string, any>;
  if (b && b.error) {
    return {
      success: b.success,
      statusCode: response.status,
      errorCode: b.error.code,
      message: b.error.message,
      errors: b.error.details,
      timestamp: b.meta?.timestamp,
    };
  }
  return b as ErrorBody;
};

const fieldErrors = (response: Response): FieldErrorBody[] =>
  errorBody(response).errors ?? [];

/** Field and code are the stable half of a validation error; message is not. */
const errorIdentities = (response: Response) =>
  fieldErrors(response).map(({ field, code }) => ({ field, code }));

const signUpSchema = z
  .object({
    email: z.email(),
    password: z.string().min(8).max(64),
    referenceId: z.uuid(),
    role: z.enum(['admin', 'member']),
    tags: z.array(z.string()).min(1),
    age: z.coerce.number().int().min(18),
    // Strict at this level too, so nested unknown keys are rejected and
    // addressable rather than silently dropped.
    address: z
      .object({
        city: z.string().min(3),
      })
      .strict(),
    // Deliberately *not* strict, to pin down the other half of the policy:
    // strictness is a per-schema decision made by whoever describes the
    // shape, not something the pipe imposes from above.
    preferences: z
      .object({
        theme: z.string(),
      })
      .optional(),
  })
  // The Zod expression of `whitelist` + `forbidNonWhitelisted`: unknown keys
  // are rejected by the schema that already describes the shape.
  .strict();

class SignUpDto extends createZodDto(signUpSchema) {}

@Controller('test-i18n')
class TestI18nController {
  @Get('user-not-found')
  userNotFound(): never {
    // Domain code states *what* happened. No language, no translation key.
    throw new AppException('USER_NOT_FOUND');
  }

  @Get('forbidden')
  forbidden(): never {
    throw new ForbiddenException();
  }

  @Get('unprocessable')
  unprocessable(): never {
    throw new HttpException('nope', HttpStatus.UNPROCESSABLE_ENTITY);
  }

  @Get('method-not-allowed')
  methodNotAllowed(): never {
    throw new HttpException('nope', HttpStatus.METHOD_NOT_ALLOWED);
  }

  @Get('unavailable')
  unavailable(): never {
    throw new HttpException('nope', HttpStatus.SERVICE_UNAVAILABLE);
  }

  @Get('teapot')
  teapot(): never {
    throw new HttpException('nope', HttpStatus.I_AM_A_TEAPOT);
  }

  @Get('boom')
  boom(): never {
    throw new Error(
      'connection to postgres://user:hunter2@db.internal:5432 failed',
    );
  }

  @Post('sign-up')
  signUp(@Body() dto: SignUpDto) {
    return dto;
  }
}

const VALID_PAYLOAD = {
  email: 'user@example.com',
  password: 'super-secret-password',
  referenceId: '3f1b2c9e-8a5d-4f6b-9c2e-1d7a5b3c8e04',
  role: 'member',
  tags: ['beta'],
  age: 30,
  address: { city: 'Damascus' },
};

async function createApp(
  options: { bodyParser: boolean } = { bodyParser: true },
): Promise<INestApplication> {
  // `MailModule` now selects a delivery driver from configuration and logs
  // through pino, so it needs both modules present. The sender address is set
  // here rather than in `setup-env.ts` to keep the requirement visible next to
  // the import that creates it.
  process.env.MAIL_DRIVER ??= 'log';
  process.env.MAIL_FROM_ADDRESS ??= 'no-reply@example.test';

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: configurations }),
      LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
      AppI18nModule,
      HttpInfrastructureModule,
      MailModule,
    ],
    controllers: [TestI18nController],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: options.bodyParser,
  });

  await app.init();
  return app;
}

describe('Backend i18n (e2e)', () => {
  let app: INestApplication;
  let server: App;
  let mailRenderer: MailRendererService;

  beforeAll(async () => {
    app = await createApp();
    server = app.getHttpServer() as App;
    mailRenderer = app.get(MailRendererService);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('error localization', () => {
    it('keeps errorCode stable while translating the message to Arabic', async () => {
      const response = await request(server)
        .get('/test-i18n/user-not-found')
        .set('X-App-Locale', 'ar');

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: 'المستخدم غير موجود في النظام',
        },
      });
      expect(errorBody(response).timestamp).toEqual(expect.any(String));
    });

    it('returns the same errorCode with an English message', async () => {
      const response = await request(server)
        .get('/test-i18n/user-not-found')
        .set('X-App-Locale', 'en');

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User was not found',
        },
      });
    });

    it('falls back to Arabic when the request carries no locale', async () => {
      const response = await request(server).get('/test-i18n/user-not-found');

      expect(errorBody(response).message).toBe('المستخدم غير موجود في النظام');
    });

    it('localizes framework exceptions that carry no domain code', async () => {
      const response = await request(server)
        .get('/test-i18n/forbidden')
        .set('X-App-Locale', 'en');

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        error: {
          code: 'FORBIDDEN',
          message: 'You do not have permission to perform this action',
        },
      });
    });
  });

  describe('HTTP status preservation', () => {
    // Localization generalises a status into a code clients can branch on; it
    // must never feed that code back into the status. These are the cases
    // where the nearest code has a *different* default status than the
    // exception was raised with.
    it.each([
      ['unprocessable', HttpStatus.UNPROCESSABLE_ENTITY, 'BAD_REQUEST'],
      ['method-not-allowed', HttpStatus.METHOD_NOT_ALLOWED, 'BAD_REQUEST'],
      ['unavailable', HttpStatus.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE'],
      ['teapot', HttpStatus.I_AM_A_TEAPOT, 'BAD_REQUEST'],
    ])(
      'preserves the original status for /%s (%i)',
      async (route, status, expectedCode) => {
        const response = await request(server)
          .get(`/test-i18n/${route}`)
          .set('X-App-Locale', 'en');

        expect(response.status).toBe(status);
        expect(errorBody(response).statusCode).toBe(status);
        expect(errorBody(response).errorCode).toBe(expectedCode);
        expect(errorBody(response).message).toEqual(expect.any(String));
      },
    );
  });

  describe('locale resolution over HTTP', () => {
    it('lets X-App-Locale win over cookie and accept-language', async () => {
      const response = await request(server)
        .get('/test-i18n/user-not-found')
        .set('X-App-Locale', 'en')
        .set('Cookie', 'APP_LOCALE=ar')
        .set('Accept-Language', 'ar');

      expect(errorBody(response).message).toBe('User was not found');
    });

    it('lets the APP_LOCALE cookie win over accept-language', async () => {
      const response = await request(server)
        .get('/test-i18n/user-not-found')
        .set('Cookie', 'APP_LOCALE=en')
        .set('Accept-Language', 'ar');

      expect(errorBody(response).message).toBe('User was not found');
    });

    it('uses accept-language when nothing more explicit is sent', async () => {
      const response = await request(server)
        .get('/test-i18n/user-not-found')
        .set('Accept-Language', 'en-US,en;q=0.9');

      expect(errorBody(response).message).toBe('User was not found');
    });

    it('ignores an unsupported X-App-Locale and continues the chain', async () => {
      const response = await request(server)
        .get('/test-i18n/user-not-found')
        .set('X-App-Locale', 'klingon')
        .set('Accept-Language', 'en');

      expect(errorBody(response).message).toBe('User was not found');
    });

    it('falls back safely when every candidate is unsupported', async () => {
      const response = await request(server)
        .get('/test-i18n/user-not-found')
        .set('X-App-Locale', 'klingon')
        .set('Cookie', 'APP_LOCALE=fr')
        .set('Accept-Language', 'de');

      expect(errorBody(response).message).toBe('المستخدم غير موجود في النظام');
    });

    it('survives a malformed locale cookie instead of failing the request', async () => {
      const response = await request(server)
        .get('/test-i18n/user-not-found')
        .set('Cookie', 'APP_LOCALE=%ZZ')
        .set('Accept-Language', 'en');

      expect(response.status).toBe(404);
      expect(errorBody(response).message).toBe('User was not found');
    });
  });

  describe('unknown errors', () => {
    it('returns a generic localized message and leaks nothing internal', async () => {
      const response = await request(server)
        .get('/test-i18n/boom')
        .set('X-App-Locale', 'en');

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error occurred, please try again later',
        },
      });

      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain('postgres://');
      expect(serialized).not.toContain('hunter2');
      expect(serialized).not.toContain('db.internal');
      expect(serialized).not.toContain('stack');
    });
  });

  describe('validation localization', () => {
    it('accepts a valid payload and applies schema coercion', async () => {
      const response = await request(server)
        .post('/test-i18n/sign-up')
        .send({ ...VALID_PAYLOAD, age: '30' });

      expect(response.status).toBe(201);
      // `transform: true` equivalent — the handler receives parsed output.
      expect((response.body as { data: { age: number } }).data.age).toBe(30);
    });

    it('translates every field error to Arabic while keeping field and code stable', async () => {
      const response = await request(server)
        .post('/test-i18n/sign-up')
        .set('X-App-Locale', 'ar')
        .send({
          email: 'not-an-email',
          password: 'short',
          referenceId: 'not-a-uuid',
          role: 'superuser',
          tags: [],
          age: 12,
          address: { city: 'a' },
        });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'بيانات الطلب غير صالحة',
        },
      });

      expect(fieldErrors(response)).toEqual(
        expect.arrayContaining([
          {
            field: 'email',
            code: 'INVALID_EMAIL',
            message: 'البريد الإلكتروني غير صالح',
          },
          {
            field: 'referenceId',
            code: 'INVALID_UUID',
            message: 'المعرّف غير صالح',
          },
          {
            field: 'role',
            code: 'INVALID_ENUM',
            message: 'القيمة غير مسموح بها',
          },
          {
            field: 'tags',
            code: 'ARRAY_MIN_SIZE',
            message: 'يجب أن تحتوي القائمة على 1 عنصر على الأقل',
          },
          {
            field: 'age',
            code: 'MIN',
            message: 'يجب ألا تقل القيمة عن 18',
          },
        ]),
      );
    });

    it('interpolates constraint arguments into the localized message', async () => {
      const response = await request(server)
        .post('/test-i18n/sign-up')
        .set('X-App-Locale', 'en')
        .send({ ...VALID_PAYLOAD, password: 'short' });

      expect(fieldErrors(response)).toContainEqual({
        field: 'password',
        code: 'MIN_LENGTH',
        message: 'Must be at least 8 characters long',
      });
    });

    it('addresses nested object failures by dotted path', async () => {
      const response = await request(server)
        .post('/test-i18n/sign-up')
        .set('X-App-Locale', 'en')
        .send({ ...VALID_PAYLOAD, address: { city: 'a' } });

      expect(fieldErrors(response)).toContainEqual({
        field: 'address.city',
        code: 'MIN_LENGTH',
        message: 'Must be at least 3 characters long',
      });
    });

    it('distinguishes a missing field from a wrongly typed one', async () => {
      const { password, ...withoutPassword } = VALID_PAYLOAD;
      void password;

      const response = await request(server)
        .post('/test-i18n/sign-up')
        .set('X-App-Locale', 'en')
        .send({ ...withoutPassword, tags: 'not-an-array' });

      expect(fieldErrors(response)).toEqual(
        expect.arrayContaining([
          {
            field: 'password',
            code: 'REQUIRED',
            message: 'This field is required',
          },
          {
            field: 'tags',
            code: 'NOT_ARRAY',
            message: 'The value must be an array',
          },
        ]),
      );
    });

    it('keeps field and code identical across languages, changing only the message', async () => {
      const payload = { ...VALID_PAYLOAD, email: 'nope' };

      const [arabic, english] = await Promise.all([
        request(server)
          .post('/test-i18n/sign-up')
          .set('X-App-Locale', 'ar')
          .send(payload),
        request(server)
          .post('/test-i18n/sign-up')
          .set('X-App-Locale', 'en')
          .send(payload),
      ]);

      expect(errorIdentities(arabic)).toEqual(errorIdentities(english));
      expect(fieldErrors(arabic)[0].message).not.toBe(
        fieldErrors(english)[0].message,
      );
    });

    it('rejects unknown properties, naming each offending key', async () => {
      const response = await request(server)
        .post('/test-i18n/sign-up')
        .set('X-App-Locale', 'en')
        .send({ ...VALID_PAYLOAD, isAdmin: true });

      expect(response.status).toBe(400);
      expect(errorBody(response).errorCode).toBe('VALIDATION_ERROR');
      expect(fieldErrors(response)).toContainEqual({
        field: 'isAdmin',
        code: 'UNRECOGNIZED_KEY',
        message: 'This field is not recognised and is not allowed',
      });
    });

    it('addresses an unknown key inside a strict nested object by its full path', async () => {
      const response = await request(server)
        .post('/test-i18n/sign-up')
        .set('X-App-Locale', 'en')
        .send({
          ...VALID_PAYLOAD,
          address: { city: 'Damascus', extra: true },
        });

      expect(response.status).toBe(400);
      expect(fieldErrors(response)).toContainEqual({
        field: 'address.extra',
        code: 'UNRECOGNIZED_KEY',
        message: 'This field is not recognised and is not allowed',
      });
    });

    it('leaves a non-strict nested object to strip its own unknown keys', async () => {
      // The other half of the policy: strictness belongs to each schema, so a
      // nested object that does not ask for it keeps Zod's default — drop the
      // key, accept the request — instead of the pipe enforcing strictness
      // recursively behind the schema author's back.
      const response = await request(server)
        .post('/test-i18n/sign-up')
        .set('X-App-Locale', 'en')
        .send({
          ...VALID_PAYLOAD,
          preferences: { theme: 'dark', extra: true },
        });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        success: true,
        data: { preferences: { theme: 'dark' } },
      });
      expect(
        (response.body as { data: { preferences: Record<string, unknown> } })
          .data.preferences,
      ).not.toHaveProperty('extra');
    });
  });

  describe('mail localization', () => {
    it('renders an Arabic RTL email from the job payload', () => {
      const mail = mailRenderer.render({
        template: 'PASSWORD_RESET',
        locale: 'ar',
        to: 'user@example.com',
        variables: {
          name: 'عدنان',
          actionUrl: 'https://example.com/reset?token=abc123',
          expiresInMinutes: 30,
        },
      });

      expect(mail.subject).toBe('إعادة تعيين كلمة المرور');
      expect(mail.direction).toBe('rtl');
      expect(mail.html).toContain('<html lang="ar" dir="rtl">');
      expect(mail.html).toContain('عدنان');
      expect(mail.html).toContain('30');
      expect(mail.html).toContain('https://example.com/reset?token=abc123');
      // The URL is isolated from the surrounding right-to-left text.
      expect(mail.html).toContain('<bdi dir="ltr">');
    });

    it('renders an English LTR email from the same template', () => {
      const mail = mailRenderer.render({
        template: 'PASSWORD_RESET',
        locale: 'en',
        to: 'user@example.com',
        variables: {
          name: 'Adnan',
          actionUrl: 'https://example.com/reset?token=abc123',
          expiresInMinutes: 30,
        },
      });

      expect(mail.subject).toBe('Reset your password');
      expect(mail.direction).toBe('ltr');
      expect(mail.html).toContain('<html lang="en" dir="ltr">');
      expect(mail.html).toContain('Hi Adnan');
    });

    it('produces identical output on a retry of the same job payload', () => {
      const job = {
        template: 'EMAIL_VERIFICATION',
        locale: 'ar',
        to: 'user@example.com',
        variables: {
          name: 'عدنان',
          actionUrl: 'https://example.com/verify?token=xyz',
        },
      } as const;

      // A worker re-running a failed job must send the language recorded in
      // the payload, not one derived from whatever context exists at retry
      // time — including when that retry happens inside a request for the
      // other locale.
      const first = mailRenderer.render(job);
      const retry = mailRenderer.render(job);

      expect(retry).toEqual(first);
      expect(retry.html).toContain('<html lang="ar" dir="rtl">');
    });

    it('escapes user-supplied values instead of interpolating raw HTML', () => {
      const mail = mailRenderer.render({
        template: 'EMAIL_VERIFICATION',
        locale: 'en',
        to: 'user@example.com',
        variables: {
          name: '<script>alert(1)</script>',
          actionUrl: 'https://example.com/verify',
        },
      });

      expect(mail.html).not.toContain('<script>');
      expect(mail.html).toContain('&lt;script&gt;');
    });
  });
});

/**
 * `main.ts` bootstraps with `bodyParser: false`. Anything asserted against a
 * default test app proves nothing about production unless the same option is
 * used, so the request-scoped behaviour is re-checked under that bootstrap.
 */
describe('Backend i18n under the production bootstrap (bodyParser: false)', () => {
  let app: INestApplication;
  let server: App;

  beforeAll(async () => {
    app = await createApp({ bodyParser: false });
    server = app.getHttpServer() as App;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('resolves the locale and localizes errors', async () => {
    const arabic = await request(server).get('/test-i18n/user-not-found');
    const english = await request(server)
      .get('/test-i18n/user-not-found')
      .set('X-App-Locale', 'en');

    expect(errorBody(arabic).message).toBe('المستخدم غير موجود في النظام');
    expect(errorBody(english).message).toBe('User was not found');
  });

  it('preserves original HTTP statuses', async () => {
    const response = await request(server).get('/test-i18n/unprocessable');

    expect(response.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(errorBody(response).statusCode).toBe(
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  });

  it('still refuses an invalid body rather than accepting it unvalidated', async () => {
    // Without a body parser Express leaves `req.body` undefined, so the DTO
    // sees no input at all. The contract that matters here is that the
    // request is *rejected* with the standard localized envelope — validation
    // never silently passes because parsing was skipped.
    const response = await request(server)
      .post('/test-i18n/sign-up')
      .set('X-App-Locale', 'en')
      .send({ ...VALID_PAYLOAD, email: 'not-an-email' });

    expect(response.status).toBe(400);
    expect(errorBody(response).errorCode).toBe('VALIDATION_ERROR');
    expect(fieldErrors(response).length).toBeGreaterThan(0);
  });
});
