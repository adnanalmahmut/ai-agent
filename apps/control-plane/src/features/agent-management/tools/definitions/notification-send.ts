import { z } from 'zod';

import type { ToolDefinition } from '../../../../ai/tools/tool.types';

export const NOTIFICATION_SUBJECT_MAX_LENGTH = 120;
export const NOTIFICATION_BODY_MAX_LENGTH = 2_000;

export const notificationSendInput = z
  .object({
    recipientMemberId: z.string().trim().min(1).max(120),
    subject: z.string().trim().min(1).max(NOTIFICATION_SUBJECT_MAX_LENGTH),
    body: z.string().trim().min(1).max(NOTIFICATION_BODY_MAX_LENGTH),
  })
  .strict();

export type NotificationSendInput = z.infer<typeof notificationSendInput>;

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
