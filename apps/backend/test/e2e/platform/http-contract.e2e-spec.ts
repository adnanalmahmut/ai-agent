import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Controller, Get, HttpCode, Post, Body, Res } from '@nestjs/common';
import type { Response } from 'express';
import request from 'supertest';
import { z } from 'zod';

import { createZodDto } from '../../../src/infrastructure/http/validation';
import { RawResponse } from '../../../src/infrastructure/http/response';
import { AppException } from '../../../src/core/errors';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { createHarness, type Harness } from '../../support/auth-harness';

class TestDtoSchema extends createZodDto(
  z.object({
    name: z.string().min(3),
  }),
) {}

@Controller('test-contract')
@AllowAnonymous()
class TestContractController {
  @Post('json')
  parseJson(@Body() dto: TestDtoSchema) {
    return { received: dto.name };
  }

  @Post('urlencoded')
  parseUrlencoded(@Body() body: Record<string, string>) {
    return { received: body.name };
  }

  @Get('app-exception')
  throwAppException() {
    throw new AppException('USER_NOT_FOUND');
  }

  @Get('internal-context-error')
  throwInternalContextError() {
    throw new AppException('USER_NOT_FOUND', {
      context: { secretQuery: 'SELECT * FROM users', internalId: 42 },
    });
  }

  @Get('public-details-error')
  throwPublicDetailsError() {
    throw new AppException('SERVICE_UNAVAILABLE', {
      publicDetails: { postgres: { status: 'down' } },
    });
  }

  @Get('unknown-error')
  throwUnknownError() {
    throw new Error('Secret database internal failure stack trace');
  }

  @Get('service-unavailable')
  throwServiceUnavailable() {
    throw new AppException('QUEUE_UNAVAILABLE');
  }

  @Get('no-content')
  @HttpCode(204)
  noContent() {
    return;
  }

  @Get('raw-sse')
  @RawResponse()
  rawSse(@Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.send('data: hello sse\n\n');
  }
}

@Controller('authors')
@AllowAnonymous()
class TestAuthorsController {
  @Get()
  listAuthors() {
    return [{ id: 'author_1', name: 'Author Name' }];
  }
}

describe('HTTP Contract & Infrastructure (e2e)', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({
      globalPrefix: 'api',
      controllers: [TestContractController, TestAuthorsController],
    });
  }, 120_000);

  afterAll(async () => {
    await harness.close();
  });

  describe('Request ID & Pino Correlation', () => {
    it('populates X-Request-ID header on all routes and matches meta.requestId', async () => {
      const res = await request(harness.server)
        .get('/api/health/live')
        .expect(200);

      const headerReqId = res.headers['x-request-id'];
      expect(headerReqId).toBeDefined();
      expect(typeof headerReqId).toBe('string');
      expect(headerReqId).toMatch(/^req_/);
      expect(res.body.meta.requestId).toBe(headerReqId);
    });

    it('preserves client-provided X-Request-ID header in response header and meta.requestId', async () => {
      const customId = 'req_custom_12345';
      const res = await request(harness.server)
        .get('/api/health/live')
        .set('X-Request-ID', customId)
        .expect(200);

      expect(res.headers['x-request-id']).toBe(customId);
      expect(res.body.meta.requestId).toBe(customId);
    });

    it('rejects oversized client-provided X-Request-ID (>128 chars) and generates a safe server ID', async () => {
      const oversizedId = 'req_' + 'a'.repeat(150);
      const res = await request(harness.server)
        .get('/api/health/live')
        .set('X-Request-ID', oversizedId)
        .expect(200);

      expect(res.headers['x-request-id']).not.toBe(oversizedId);
      expect(res.headers['x-request-id']).toMatch(/^req_[0-9a-f-]+$/);
      expect(res.body.meta.requestId).toBe(res.headers['x-request-id']);
    });

    it('rejects client-provided X-Request-ID with invalid characters and generates a safe server ID', async () => {
      const invalidId = 'req_invalid <script>alert(1)</script>';
      const res = await request(harness.server)
        .get('/api/health/live')
        .set('X-Request-ID', invalidId)
        .expect(200);

      expect(res.headers['x-request-id']).not.toBe(invalidId);
      expect(res.headers['x-request-id']).toMatch(/^req_[0-9a-f-]+$/);
      expect(res.body.meta.requestId).toBe(res.headers['x-request-id']);
    });
  });

  describe('Body Parser & JSON / URL-encoded Handling', () => {
    it('parses POST application/json for non-auth routes', async () => {
      const res = await request(harness.server)
        .post('/api/test-contract/json')
        .send({ name: 'Adnan' })
        .expect(201);

      expect(res.body).toMatchObject({
        success: true,
        data: { received: 'Adnan' },
        meta: {
          requestId: expect.any(String),
          timestamp: expect.any(String),
        },
      });
    });

    it('parses POST application/x-www-form-urlencoded for non-auth routes', async () => {
      const res = await request(harness.server)
        .post('/api/test-contract/urlencoded')
        .type('form')
        .send('name=AdnanForm')
        .expect(201);

      expect(res.body).toMatchObject({
        success: true,
        data: { received: 'AdnanForm' },
      });
    });

    it('formats payload exceeding limit (>1MB) into 413 error response', async () => {
      const largePayload = 'a'.repeat(1.5 * 1024 * 1024); // 1.5MB
      const res = await request(harness.server)
        .post('/api/test-contract/json')
        .send({ name: largePayload });

      expect(res.status).toBe(413);
      expect(res.body.success).toBe(false);
      expect(res.headers['x-request-id']).toBeDefined();
    });

    it('formats invalid DTO into unified VALIDATION_ERROR envelope', async () => {
      const res = await request(harness.server)
        .post('/api/test-contract/json')
        .send({ name: 'ab' }) // min 3 chars
        .expect(400);

      expect(res.body).toMatchObject({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: expect.any(String),
          details: expect.arrayContaining([
            expect.objectContaining({
              field: 'name',
              code: expect.any(String),
            }),
          ]),
        },
        meta: {
          requestId: expect.any(String),
          timestamp: expect.any(String),
        },
      });
    });
  });

  describe('Route Boundaries (/api/authors vs /api/auth/*)', () => {
    it('wraps /api/authors in unified application success envelope', async () => {
      const res = await request(harness.server).get('/api/authors').expect(200);

      expect(res.body).toMatchObject({
        success: true,
        data: [{ id: 'author_1', name: 'Author Name' }],
        meta: {
          requestId: expect.any(String),
          timestamp: expect.any(String),
        },
      });
    });
  });

  describe('Unified Success & Error Envelopes', () => {
    it('wraps application success response cleanly', async () => {
      const res = await request(harness.server)
        .get('/api/health/live')
        .expect(200);

      expect(res.body).toMatchObject({
        success: true,
        data: expect.objectContaining({ status: 'ok' }),
        meta: {
          requestId: expect.any(String),
          timestamp: expect.any(String),
        },
      });
    });

    it('wraps AppException into unified error envelope without redundant statusCode field', async () => {
      const res = await request(harness.server)
        .get('/api/test-contract/app-exception')
        .expect(404);

      expect(res.body).toMatchObject({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: expect.any(String),
        },
        meta: {
          requestId: expect.any(String),
          timestamp: expect.any(String),
        },
      });
      expect(res.body.statusCode).toBeUndefined();
    });

    it('never leaks internal context into error response or details', async () => {
      const res = await request(harness.server)
        .get('/api/test-contract/internal-context-error')
        .expect(404);

      expect(res.body).toMatchObject({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: expect.any(String),
        },
      });
      // Details must be undefined and internal context keys must not leak
      expect(res.body.error.details).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('secretQuery');
      expect(JSON.stringify(res.body)).not.toContain('SELECT * FROM users');
      expect(JSON.stringify(res.body)).not.toContain('internalId');
    });

    it('serializes explicit publicDetails into error.details', async () => {
      const res = await request(harness.server)
        .get('/api/test-contract/public-details-error')
        .expect(503);

      expect(res.body).toMatchObject({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          details: {
            postgres: {
              status: 'down',
            },
          },
        },
      });
    });

    it('converts unknown errors to generic 500 without leaking stack trace or SQL details', async () => {
      const res = await request(harness.server)
        .get('/api/test-contract/unknown-error')
        .expect(500);

      expect(res.body).toMatchObject({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: expect.any(String),
        },
        meta: {
          requestId: expect.any(String),
        },
      });
      expect(JSON.stringify(res.body)).not.toContain(
        'Secret database internal failure',
      );
    });

    it('keeps 503 Service Unavailable status when infrastructure exception is thrown', async () => {
      const res = await request(harness.server)
        .get('/api/test-contract/service-unavailable')
        .expect(503);

      expect(res.body).toMatchObject({
        success: false,
        error: {
          code: 'QUEUE_UNAVAILABLE',
        },
      });
    });
  });

  describe('Bypass Rules & Better Auth Compatibility', () => {
    it('automatically bypasses wrapping on 204 No Content responses', async () => {
      const res = await request(harness.server)
        .get('/api/test-contract/no-content')
        .expect(204);

      expect(res.text).toBe('');
    });

    it('bypasses wrapping on @RawResponse() decorated endpoints (e.g. SSE)', async () => {
      const res = await request(harness.server)
        .get('/api/test-contract/raw-sse')
        .expect(200);

      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.text).toBe('data: hello sse\n\n');
    });

    it('preserves native Better Auth sign-up response shape and handles auth body stream', async () => {
      const uniqueEmail = `test-auth-${Date.now()}@example.com`;
      const res = await request(harness.server)
        .post('/api/auth/sign-up/email')
        .send({
          email: uniqueEmail,
          password: 'password123',
          name: 'Auth User',
        })
        .expect(200);

      // Native Better Auth response shape: { token, user: { id, email, ... } }
      expect(res.body.user).toBeDefined();
      expect(res.body.user.email).toBe(uniqueEmail);
      expect(res.body.token).toBeDefined();
      expect(res.body.success).toBeUndefined();
      expect(res.body.data).toBeUndefined();
      expect(res.headers['x-request-id']).toBeDefined();
      expect(res.headers['x-request-id']).toMatch(/^req_/);
    });

    it('preserves native Better Auth sign-in failure error shape', async () => {
      const res = await request(harness.server)
        .post('/api/auth/sign-in/email')
        .send({ email: 'nonexistent@example.com', password: 'wrongpassword' })
        .expect(401);

      expect(res.body.message).toBeDefined();
      expect(res.body.success).toBeUndefined();
      expect(res.headers['x-request-id']).toBeDefined();
      expect(res.headers['x-request-id']).toMatch(/^req_/);
    });

    it('preserves client-provided X-Request-ID on native Better Auth routes', async () => {
      const customAuthId = 'req_auth_custom_777';
      const res = await request(harness.server)
        .post('/api/auth/sign-in/email')
        .set('X-Request-ID', customAuthId)
        .send({ email: 'nonexistent@example.com', password: 'wrongpassword' })
        .expect(401);

      expect(res.headers['x-request-id']).toBe(customAuthId);
    });
  });
});
