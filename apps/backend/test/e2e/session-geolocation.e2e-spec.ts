import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';

import {
  cookieOf,
  createHarness,
  createUser,
  type Harness,
} from '../support/auth-harness';

describe('Better Auth session geolocation', () => {
  let harness: Harness;
  const lookup = jest.fn((ipAddress: string) => {
    void ipAddress;
    return Promise.resolve({ country: 'TR', city: 'Istanbul' });
  });

  beforeAll(async () => {
    harness = await createHarness({ geoIp: { lookup } });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('stores server-generated location and ignores browser fields', async () => {
    const user = await createUser(harness, { signIn: false });

    const response = await request(harness.server)
      .post('/api/auth/sign-in/email')
      .set('X-Real-IP', '1.2.3.4')
      .send({
        email: user.email,
        password: user.password,
        country: 'US',
        city: 'Attacker supplied',
      })
      .expect(200);

    const session = await harness.prisma.session.findFirstOrThrow({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: { ipAddress: true, country: true, city: true },
    });

    expect(lookup).toHaveBeenCalledWith('127.0.0.1');
    expect(session).toEqual({
      ipAddress: '127.0.0.1',
      country: 'TR',
      city: 'Istanbul',
    });

    const cookie = cookieOf(response);

    const listed = await request(harness.server)
      .get('/api/auth/list-sessions')
      .set('Cookie', cookie)
      .expect(200);

    expect(listed.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ country: 'TR', city: 'Istanbul' }),
      ]),
    );
  });
});
