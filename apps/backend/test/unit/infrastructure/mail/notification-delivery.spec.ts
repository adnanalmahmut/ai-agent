import { describe, expect, it } from '@jest/globals';

import { createNotificationDelivery } from '../../../../src/infrastructure/mail/notification-delivery';

const from = { address: 'no-reply@example.test', name: 'Acme' };
const logger = { setContext: () => undefined, info: () => undefined } as never;

describe('createNotificationDelivery', () => {
  it('is idempotent under the log driver', () => {
    const delivery = createNotificationDelivery(
      { driver: 'log', from, writeHtml: false },
      logger,
    );

    expect(delivery.idempotent).toBe(true);
    expect(delivery.sender).toBe('Acme <no-reply@example.test>');
  });

  it('is idempotent under Resend', () => {
    const delivery = createNotificationDelivery(
      { driver: 'resend', from, apiKey: 're_test_key_value', timeoutMs: 1_000 },
      logger,
    );

    expect(delivery.idempotent).toBe(true);
  });

  it.each([
    [{ driver: 'ses' as const, from, region: 'eu-west-1', timeoutMs: 1_000 }],
    [
      {
        driver: 'smtp' as const,
        from,
        host: 'localhost',
        port: 587,
        secure: false,
        timeoutMs: 1_000,
      },
    ],
  ])('composes but refuses idempotency under %o', (config) => {
    const delivery = createNotificationDelivery(config, logger);

    expect(delivery.idempotent).toBe(false);
    expect(delivery.sender).toBe('Acme <no-reply@example.test>');
  });
});
