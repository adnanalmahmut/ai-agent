import { describe, expect, it, jest } from '@jest/globals';

import { LogNotificationDelivery } from '../../../../src/infrastructure/mail/log-notification.delivery';

const from = { address: 'no-reply@example.test', name: 'Acme' };

const message = {
  to: 'sara@example.com',
  subject: 'Handoff ready: the kettle piece',
  html: '<p>Please review the draft.</p>',
  text: 'Please review the draft.',
  idempotencyKey: 'notification.send@1:exec_1',
};

describe('LogNotificationDelivery', () => {
  const build = () => {
    const info = jest.fn();
    const delivery = new LogNotificationDelivery(from, {
      setContext: () => undefined,
      info,
    } as never);
    return { delivery, info };
  };

  it('is idempotent and replays the same id for the same key', async () => {
    const { delivery } = build();

    const first = await delivery.deliver(message);
    const second = await delivery.deliver(message);

    expect(delivery.idempotent).toBe(true);
    expect(first).toEqual(second);
    expect(first.kind).toBe('accepted');
    if (first.kind === 'accepted') {
      expect(first.providerMessageId).toMatch(/^log:[0-9a-f]{32}$/);
      expect(first.providerMessageId).not.toContain('exec_1');
    }
  });

  it('logs a masked recipient and lengths, never the message or the key', async () => {
    const { delivery, info } = build();

    await delivery.deliver(message);

    expect(info).toHaveBeenCalledTimes(1);
    const [fields] = info.mock.calls[0] as [Record<string, unknown>];
    const serialized = JSON.stringify(fields);

    expect(Object.keys(fields).sort()).toEqual([
      'bodyLength',
      'driver',
      'event',
      'providerMessageId',
      'subjectLength',
      'to',
    ]);
    expect(serialized).not.toContain('sara@example.com');
    expect(serialized).not.toContain('kettle');
    expect(serialized).not.toContain('Please review');
    expect(serialized).not.toContain('notification.send@1:exec_1');
  });
});
