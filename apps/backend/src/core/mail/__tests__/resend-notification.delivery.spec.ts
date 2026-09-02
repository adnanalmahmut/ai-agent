import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ResendNotificationDelivery } from '../resend-notification.delivery';
import type { NotificationMessage } from '../notification-delivery';

const message: NotificationMessage = {
  to: 'sara@example.com',
  subject: 'Handoff ready',
  html: '<p>Ready</p>',
  text: 'Ready',
  idempotencyKey: 'notification.send@1:exec_1',
};

type SendResult = {
  data: { id: string } | null;
  error: { name: string; statusCode: number | null; message: string } | null;
  headers: null;
};

describe('ResendNotificationDelivery', () => {
  let send: jest.Mock<
    (payload: unknown, options: unknown) => Promise<SendResult>
  >;

  const delivery = () => {
    const instance = new ResendNotificationDelivery({
      driver: 'resend',
      from: { address: 'no-reply@example.test', name: 'Acme' },
      apiKey: 're_test_key_value',
      timeoutMs: 1_000,
    });
    // The constructed SDK client, with its network call replaced.
    (instance as unknown as { client: { emails: { send: unknown } } }).client =
      {
        emails: { send },
      };
    return instance;
  };

  beforeEach(() => {
    send = jest.fn(() =>
      Promise.resolve({ data: { id: 'msg_1' }, error: null, headers: null }),
    );
  });

  it('declares itself idempotent', () => {
    expect(delivery().idempotent).toBe(true);
  });

  it('sends the payload with the key as the Idempotency-Key option', async () => {
    await expect(delivery().deliver(message)).resolves.toEqual({
      kind: 'accepted',
      providerMessageId: 'msg_1',
    });

    expect(send).toHaveBeenCalledWith(
      {
        from: 'Acme <no-reply@example.test>',
        to: ['sara@example.com'],
        subject: 'Handoff ready',
        html: '<p>Ready</p>',
        text: 'Ready',
      },
      { idempotencyKey: 'notification.send@1:exec_1' },
    );
  });

  it.each([
    ['validation_error', 422],
    ['invalid_from_address', 403],
    ['invalid_idempotency_key', 400],
    ['invalid_idempotent_request', 409],
    ['invalid_api_key', 401],
  ])(
    'classifies %s as rejected, keeping the provider text',
    async (name, statusCode) => {
      send.mockResolvedValue({
        data: null,
        error: {
          name,
          statusCode,
          message: `refused sara@example.com: ${name}`,
        },
        headers: null,
      });

      const outcome = await delivery().deliver(message);

      expect(outcome).toEqual({ kind: 'rejected' });
      expect(JSON.stringify(outcome)).not.toContain('sara@example.com');
    },
  );

  it.each([
    ['concurrent_idempotent_requests', 409],
    ['rate_limit_exceeded', 429],
    ['application_error', 500],
    ['internal_server_error', 500],
    ['daily_quota_exceeded', 429],
    ['some_future_code', null],
  ])(
    'classifies %s as unavailable rather than as not sent',
    async (name, statusCode) => {
      send.mockResolvedValue({
        data: null,
        error: { name, statusCode, message: 'x' },
        headers: null,
      });

      await expect(delivery().deliver(message)).resolves.toEqual({
        kind: 'unavailable',
      });
    },
  );

  it('treats a transport rejection as unavailable and reads nothing from it', async () => {
    send.mockRejectedValue(
      new Error('ECONNRESET https://api.resend.com key=re_test'),
    );

    const outcome = await delivery().deliver(message);

    expect(outcome).toEqual({ kind: 'unavailable' });
    expect(JSON.stringify(outcome)).not.toContain('re_test');
  });

  it('treats a timeout as unavailable, not as rejected', async () => {
    send.mockReturnValue(new Promise(() => undefined));

    const instance = new ResendNotificationDelivery({
      driver: 'resend',
      from: { address: 'no-reply@example.test', name: 'Acme' },
      apiKey: 're_test_key_value',
      timeoutMs: 1_000,
    });
    (instance as unknown as { client: { emails: { send: unknown } } }).client =
      {
        emails: { send },
      };

    jest.useFakeTimers();
    try {
      const pending = instance.deliver(message);
      await jest.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toEqual({ kind: 'unavailable' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('treats a success with no identifier as unavailable', async () => {
    send.mockResolvedValue({ data: null, error: null, headers: null });

    await expect(delivery().deliver(message)).resolves.toEqual({
      kind: 'unavailable',
    });
  });
});
