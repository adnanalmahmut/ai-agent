import { Inject, Injectable } from '@nestjs/common';

import type { AgentValue } from '../../../ai/agents/agent.types';
import { digestStrings } from '../../../ai/tools/digest';
import {
  SideEffectPreconditionError,
  type PreparedEffect,
  type SideEffectToolImplementation,
  type ToolInvocationContext,
} from '../../../ai/tools/tool.types';
import { PrismaService } from '../../../infrastructure/database';
import {
  NOTIFICATION_DELIVERY,
  type NotificationDelivery,
} from '../../../infrastructure/mail/notification-delivery.port';
import {
  notificationSendInput,
  type NotificationSendInput,
} from './definitions/notification-send';

@Injectable()
export class NotificationSendTool implements SideEffectToolImplementation {
  readonly ref = 'notification.send@1' as const;
  readonly kind = 'side_effect' as const;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(NOTIFICATION_DELIVERY)
    private readonly delivery: NotificationDelivery,
  ) {}

  async propose(
    input: AgentValue,
    context: ToolInvocationContext,
  ): Promise<void> {
    const parsed = notificationSendInput.parse(input);

    await this.resolveRecipient(
      parsed.recipientMemberId,
      context.organizationId,
    );
  }

  async prepareEffect(
    input: AgentValue,
    context: ToolInvocationContext,
  ): Promise<PreparedEffect> {
    if (this.delivery.idempotent === false) {
      throw new SideEffectPreconditionError('delivery_unsupported');
    }

    const parsed = notificationSendInput.parse(input);
    const recipient = await this.resolveRecipient(
      parsed.recipientMemberId,
      context.organizationId,
    );
    const rendered = renderNotification(parsed);
    const payloadDigest = digestStrings([
      this.delivery.sender,
      recipient.email,
      rendered.subject,
      rendered.text,
      rendered.html,
    ]);

    return {
      payloadDigest,
      command: {
        tool: this.ref,
        payloadDigest,
        payload: {
          to: recipient.email,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
        },
      },
    };
  }

  private async resolveRecipient(
    memberId: string,
    organizationId: string,
  ): Promise<{ email: string }> {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, organizationId },
      select: {
        user: {
          select: { email: true, deletedAt: true, banned: true },
        },
      },
    });

    if (
      !member ||
      member.user.deletedAt !== null ||
      member.user.banned === true ||
      member.user.email.length === 0
    ) {
      throw new SideEffectPreconditionError('precondition_recipient');
    }

    return { email: member.user.email };
  }
}

export function renderNotification(input: NotificationSendInput): {
  subject: string;
  text: string;
  html: string;
} {
  const paragraphs = input.body
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map(
      (paragraph) =>
        `<p style="margin:0 0 12px">${escapeHtml(paragraph).replaceAll('\n', '<br>')}</p>`,
    )
    .join('\n');

  return {
    subject: input.subject,
    text: input.body,
    html: [
      '<!doctype html>',
      '<html>',
      '<body style="margin:0;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#111">',
      paragraphs,
      '</body>',
      '</html>',
    ].join('\n'),
  };
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
