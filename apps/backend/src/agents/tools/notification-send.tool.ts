import { Inject, Injectable } from '@nestjs/common';

import {
  NOTIFICATION_DELIVERY,
  type NotificationDelivery,
} from '../../core/mail/notification-delivery';
import { PrismaService } from '../../database';
import type { AgentValue } from '../agent.types';
import { digestStrings } from './digest';
import {
  notificationSendInput,
  type NotificationSendInput,
} from './definitions/notification-send';
import {
  SideEffectPreconditionError,
  type PreparedEffect,
  type SideEffectToolImplementation,
  type ToolInvocationContext,
  type ToolRef,
} from './tool.types';

/**
 * `notification.send@1`: one email to one member of the caller's own
 * organization, proposed by the model and performed by nobody until a human
 * says so.
 *
 * The recipient is resolved from a membership id against the organization the
 * run belongs to, twice. Once here at proposal time, so a model naming a
 * member who does not exist is refused before anything durable is written.
 * And once more in `prepareEffect`, from scratch, immediately before the
 * message leaves — because approval is a decision about a state of the world,
 * and the world keeps moving after a person clicks. A member removed between
 * approval and delivery is not sent to.
 *
 * Deliverable means: still a member of *this* organization, and an account
 * that is neither deactivated nor banned. The address is the account's own,
 * read at the last moment and never stored on the execution; what is stored
 * is a digest of the payload — sender, address, subject, text and HTML — so a
 * retry can prove it is sending the same thing without the row holding the
 * address.
 */
@Injectable()
export class NotificationSendTool implements SideEffectToolImplementation {
  readonly ref: ToolRef = 'notification.send@1';
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
    /**
     * Checked first, before any lookup. A deployment whose mail driver cannot
     * honour the retry contract must not perform this effect at all, and the
     * refusal should not depend on whether the recipient happened to resolve.
     */
    if (!this.delivery.idempotent) {
      throw new SideEffectPreconditionError('delivery_unsupported');
    }

    const parsed = notificationSendInput.parse(input);
    const recipient = await this.resolveRecipient(
      parsed.recipientMemberId,
      context.organizationId,
    );
    const rendered = renderNotification(parsed);

    /**
     * Everything the provider deduplicates on: sender, recipient, subject and
     * both bodies. A change to any of them between two attempts is a changed
     * request under the same key, and the digest has to say so before the
     * provider does.
     */
    return {
      payloadDigest: digestStrings([
        this.delivery.sender,
        recipient.email,
        rendered.subject,
        rendered.text,
        rendered.html,
      ]),
      deliver: (idempotencyKey) =>
        this.delivery.deliver({
          to: recipient.email,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          idempotencyKey,
        }),
    };
  }

  /**
   * The member, if they are one here and can be written to.
   *
   * `organizationId` is a predicate on the membership row, not a check on the
   * result: a membership id from another tenant must be indistinguishable
   * from one that does not exist. Every refusal is the same closed code for
   * the same reason.
   */
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

/**
 * The message, as text and as the smallest HTML that says the same thing.
 *
 * No template engine and no i18n lookup: the subject and body *are* the
 * content, approved verbatim, and the language is whatever the model wrote in.
 * The HTML exists because most clients render it in preference to text, and it
 * is built by escaping rather than by trusting — the body is model output.
 */
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
