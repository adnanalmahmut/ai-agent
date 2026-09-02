import { z } from 'zod';

import type { ToolDefinition } from '../tool.types';

export const NOTIFICATION_SUBJECT_MAX_LENGTH = 120;
export const NOTIFICATION_BODY_MAX_LENGTH = 2_000;

/**
 * The only things the model may supply.
 *
 * A *membership* id, not an email address. The recipient is resolved against
 * the caller's own organization when the proposal is made and again when the
 * effect is performed, so the model can address a person who belongs to this
 * tenant and nobody else — an address field here would make this tool an
 * exfiltration channel for anything the model has been shown. Absent by the
 * same reasoning: the sender, the provider, when to send, and any identifier
 * of the execution, the run, or the approver.
 *
 * Subject and body are bounded because they become the message verbatim, and
 * a message a person will read should be a message a person could have typed.
 */
export const notificationSendInput = z
  .object({
    recipientMemberId: z.string().trim().min(1).max(120),
    subject: z.string().trim().min(1).max(NOTIFICATION_SUBJECT_MAX_LENGTH),
    body: z.string().trim().min(1).max(NOTIFICATION_BODY_MAX_LENGTH),
  })
  .strict();

export type NotificationSendInput = z.infer<typeof notificationSendInput>;

/**
 * What the model is told: that the proposal was recorded, and nothing more.
 *
 * Deliberately not the execution id, not the approver, and not whether it was
 * or will be sent. The model's part ends when the proposal is durable; what
 * happens next is a human decision and a worker's, and telling the model an
 * identifier it cannot use would only invite it to try.
 */
export const notificationSendOutput = z
  .object({
    status: z.literal('awaiting_approval'),
  })
  .strict();

export const notificationSendTool: ToolDefinition = {
  id: 'notification.send',
  version: 1,
  runtimeName: 'notification_send_v1',
  description:
    'Propose an email notification to one member of this organization, named by their membership id. This call sends nothing: the proposal is recorded and a person with authority must approve it before any message leaves. Write the subject and body as the final text that member will read. You cannot choose the address, the sender, or the time of sending.',
  input: notificationSendInput,
  output: notificationSendOutput,
  risk: 'side_effect',
};
