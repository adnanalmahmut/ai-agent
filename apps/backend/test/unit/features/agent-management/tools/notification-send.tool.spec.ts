import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';

import type { AgentDefinition } from '../../../../../src/ai/agents/agent.types';
import { MODEL_IDS } from '../../../../../src/ai/models/model-catalog';
import type {
  ExternalEffectOutcome,
  NotificationMessage,
} from '../../../../../src/infrastructure/mail/notification-delivery.port';
import {
  NotificationSendTool,
  renderNotification,
} from '../../../../../src/features/agent-management/tools/notification-send.tool';
import {
  SideEffectPreconditionError,
  type ToolInvocationContext,
} from '../../../../../src/ai/tools/tool.types';

const definition: AgentDefinition = {
  id: 'test-agent',
  version: 1,
  runtime: 'mastra',
  instructions: 'Answer.',
  model: MODEL_IDS.openAiGpt4oMini,
  modelPolicy: {
    id: 'test-agent.model-policy.1',
    allowedModelIds: [MODEL_IDS.openAiGpt4oMini],
  },
  input: z.unknown(),
  output: z.unknown(),
  maxToolGrants: ['notification.send@1'],
};

const context: ToolInvocationContext = {
  organizationId: 'org_1',
  agentRunId: 'run_1',
  agentRunAttempt: 1,
  definition,
};

const input = {
  recipientMemberId: 'member_1',
  subject: 'Handoff ready',
  body: 'The draft is ready.\n\nPlease review <today>.',
};

type MemberRow = {
  user: { email: string; deletedAt: Date | null; banned: boolean | null };
};

describe('NotificationSendTool', () => {
  let findFirst: jest.Mock<(args: unknown) => Promise<MemberRow | null>>;
  let deliver: jest.Mock<
    (message: NotificationMessage) => Promise<ExternalEffectOutcome>
  >;
  let idempotent: boolean;
  let sender = 'Acme <no-reply@example.test>';

  const tool = () =>
    new NotificationSendTool({ member: { findFirst } } as never, {
      get idempotent() {
        return idempotent;
      },
      get sender() {
        return sender;
      },
      deliver,
    });

  const member = (overrides: Partial<MemberRow['user']> = {}): MemberRow => ({
    user: {
      email: 'sara@example.com',
      deletedAt: null,
      banned: false,
      ...overrides,
    },
  });

  beforeEach(() => {
    findFirst = jest.fn(() => Promise.resolve(member()));
    deliver = jest.fn(() =>
      Promise.resolve({
        kind: 'accepted',
        providerMessageId: 'msg_1',
      } as const),
    );
    idempotent = true;
    sender = 'Acme <no-reply@example.test>';
  });

  describe('propose', () => {
    it('resolves the recipient against the caller organization only', async () => {
      await tool().propose(input, context);

      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'member_1', organizationId: 'org_1' },
        }),
      );
    });

    it.each([
      ['no such member here', null],
      ['a deactivated account', member({ deletedAt: new Date() })],
      ['a banned account', member({ banned: true })],
      ['an account with no address', member({ email: '' })],
    ])('refuses %s with the closed recipient code', async (_name, row) => {
      findFirst.mockResolvedValue(row);

      await expect(tool().propose(input, context)).rejects.toMatchObject({
        code: 'precondition_recipient',
      });
    });

    it('refuses input its own schema refuses before any lookup', async () => {
      await expect(
        tool().propose({ ...input, to: 'x@example.com' }, context),
      ).rejects.toBeDefined();
      expect(findFirst).not.toHaveBeenCalled();
    });
  });

  describe('prepareEffect', () => {
    it('digests the effective payload and delivers exactly that payload', async () => {
      const prepared = await tool().prepareEffect(input, context);

      await prepared.deliver('notification.send@1:exec_1');

      expect(deliver).toHaveBeenCalledTimes(1);
      const [message] = deliver.mock.calls[0];

      expect(message.to).toBe('sara@example.com');
      expect(message.subject).toBe('Handoff ready');
      expect(message.text).toBe(input.body);
      expect(message.idempotencyKey).toBe('notification.send@1:exec_1');
      expect(prepared.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(prepared)).not.toContain('sara@example.com');
    });

    it('changes the digest when the recipient address changes', async () => {
      const first = await tool().prepareEffect(input, context);
      findFirst.mockResolvedValue(member({ email: 'other@example.com' }));
      const second = await tool().prepareEffect(input, context);

      expect(first.payloadDigest).not.toBe(second.payloadDigest);
    });

    it('changes the digest when the sender changes', async () => {
      const first = await tool().prepareEffect(input, context);
      sender = 'Acme <hello@example.test>';
      const second = await tool().prepareEffect(input, context);

      expect(first.payloadDigest).not.toBe(second.payloadDigest);
    });

    it('re-resolves the recipient rather than trusting the proposal', async () => {
      findFirst.mockResolvedValue(null);

      await expect(tool().prepareEffect(input, context)).rejects.toMatchObject({
        code: 'precondition_recipient',
      });
      expect(deliver).not.toHaveBeenCalled();
    });

    it('fails closed before any lookup when the driver cannot be idempotent', async () => {
      idempotent = false;

      await expect(tool().prepareEffect(input, context)).rejects.toBeInstanceOf(
        SideEffectPreconditionError,
      );
      await expect(tool().prepareEffect(input, context)).rejects.toMatchObject({
        code: 'delivery_unsupported',
      });
      expect(findFirst).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
    });
  });

  describe('renderNotification', () => {
    it('escapes the body and splits paragraphs', () => {
      const rendered = renderNotification({
        recipientMemberId: 'm',
        subject: 'S <b>',
        body: 'One <script>x</script>\nline two\n\nTwo & "three"',
      });

      expect(rendered.html).toContain(
        'One &lt;script&gt;x&lt;/script&gt;<br>line two',
      );
      expect(rendered.html).toContain('Two &amp; &quot;three&quot;');
      expect(rendered.html).not.toContain('<script>');
      expect(rendered.subject).toBe('S <b>');
      expect(rendered.text).toBe(
        'One <script>x</script>\nline two\n\nTwo & "three"',
      );
    });
  });
});
