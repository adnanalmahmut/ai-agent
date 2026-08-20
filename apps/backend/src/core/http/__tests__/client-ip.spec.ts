import { describe, expect, it, jest } from '@jest/globals';
import type { IncomingMessage } from 'node:http';

import {
  configureTrustedProxy,
  overwriteDirectClientIpHeaders,
} from '../client-ip';

const directRequest = (remoteAddress?: string) =>
  ({
    headers: {
      'x-real-ip': '1.2.3.4',
      'x-forwarded-for': '1.2.3.4',
    },
    socket: { remoteAddress },
  }) as unknown as IncomingMessage;

describe('client IP trust boundary', () => {
  it('passes the numeric hop count to Express without broad trust', () => {
    const set = jest.fn();

    configureTrustedProxy({ set } as never, { trustProxyHops: 1 });

    expect(set).toHaveBeenCalledWith('trust proxy', 1);
    expect(set).not.toHaveBeenCalledWith('trust proxy', true);
  });

  it('overwrites attacker headers with the direct socket peer', () => {
    const request = directRequest('127.0.0.1');

    overwriteDirectClientIpHeaders(request, true);

    expect(request.headers['x-real-ip']).toBe('127.0.0.1');
    expect(request.headers['x-forwarded-for']).toBe('127.0.0.1');
  });

  it('leaves headers from the production Nginx boundary untouched', () => {
    const request = directRequest('127.0.0.1');

    overwriteDirectClientIpHeaders(request, false);

    expect(request.headers['x-real-ip']).toBe('1.2.3.4');
    expect(request.headers['x-forwarded-for']).toBe('1.2.3.4');
  });

  it('removes forwarded identity when the direct socket has no address', () => {
    const request = directRequest();

    overwriteDirectClientIpHeaders(request, true);

    expect(request.headers['x-real-ip']).toBeUndefined();
    expect(request.headers['x-forwarded-for']).toBeUndefined();
  });
});
