import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Controller, Get, Req } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import type { Request } from 'express';
import request from 'supertest';

import { configureTrustedProxy } from '../../src/infrastructure/http';
import {
  createHarness,
  createUser,
  type Harness,
} from '../support/auth-harness';

@Controller('e2e/client-ip')
@AllowAnonymous()
class ClientIpController {
  @Get()
  getClientIp(@Req() req: Request) {
    return { ip: req.ip };
  }
}

describe('canonical client IP boundary', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({ controllers: [ClientIpController] });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('ignores spoofed forwarding headers from a direct local/test client', async () => {
    const response = await request(harness.server)
      .get('/e2e/client-ip')
      .set('X-Real-IP', '1.2.3.4')
      .set('X-Forwarded-For', '1.2.3.4')
      .expect(200);

    const ip = (response.body as { data: { ip: string } }).data.ip;
    expect(ip).not.toBe('1.2.3.4');
    expect(['127.0.0.1', '::ffff:127.0.0.1', '::1']).toContain(ip);
  });

  it('uses the one value that the trusted Nginx hop observed', async () => {
    const app = harness.app as NestExpressApplication;
    configureTrustedProxy(app, { trustProxyHops: 1 });

    try {
      const response = await request(harness.server)
        .get('/e2e/client-ip')
        .set('X-Real-IP', '203.0.113.20')
        .set('X-Forwarded-For', '203.0.113.20')
        .expect(200);

      expect((response.body as { data: { ip: string } }).data.ip).toBe(
        '203.0.113.20',
      );
    } finally {
      configureTrustedProxy(app, { trustProxyHops: 0 });
    }
  });

  it('prevents a direct client from spoofing Better Auth session identity', async () => {
    const user = await createUser(harness, { signIn: false });

    await request(harness.server)
      .post('/api/auth/sign-in/email')
      .set('X-Real-IP', '1.2.3.4')
      .set('X-Forwarded-For', '1.2.3.4')
      .send({ email: user.email, password: user.password })
      .expect(200);

    const session = await harness.prisma.session.findFirstOrThrow({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: { ipAddress: true },
    });

    expect(session.ipAddress).not.toBe('1.2.3.4');
    expect(session.ipAddress).toBe('127.0.0.1');
  });
});
