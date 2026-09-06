import type { ZodType } from 'zod';

import type { AgentDefinition, AgentValue } from '../agents/agent.types';
import type { ToolRef } from './tool-ref';

export {
  SIDE_EFFECT_DELIVERY,
  type SideEffectDeliveryPort,
} from './side-effect-delivery.port';
export { isToolRef, TOOL_REFS, toolRef } from './tool-ref';
export type { ToolRef } from './tool-ref';

export const TOOL_RISKS = ['read_only', 'side_effect'] as const;

export type ToolRisk = (typeof TOOL_RISKS)[number];

export type ToolDefinition = {
  id: string;
  version: number;
  runtimeName: string;
  description: string;
  input: ZodType;
  output: ZodType;
  risk: ToolRisk;
};

export type ToolInvocationContext = {
  organizationId: string;
  agentRunId: string;
  agentRunAttempt: number;
  definition: AgentDefinition;
};

export interface ToolImplementation {
  readonly ref: ToolRef;
  execute(input: AgentValue, context: ToolInvocationContext): Promise<unknown>;
}

export const SIDE_EFFECT_PRECONDITION_CODES = [
  'precondition_organization',
  'precondition_authority',
  'precondition_approval',
  'precondition_recipient',
  'delivery_unsupported',
] as const;

export type SideEffectPreconditionCode =
  (typeof SIDE_EFFECT_PRECONDITION_CODES)[number];

export class SideEffectPreconditionError extends Error {
  constructor(readonly code: SideEffectPreconditionCode) {
    super(`Side-effect precondition failed: ${code}`);
    this.name = 'SideEffectPreconditionError';
  }
}

export function isSideEffectPreconditionError(
  value: unknown,
): value is SideEffectPreconditionError {
  return value instanceof SideEffectPreconditionError;
}

export type NotificationDeliveryPayload = {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
};

export type NotificationSendDeliveryCommand = {
  readonly tool: 'notification.send@1';
  readonly payloadDigest: string;
  readonly payload: NotificationDeliveryPayload;
};

export type SideEffectDeliveryCommand = NotificationSendDeliveryCommand;

export type PreparedEffect = {
  readonly payloadDigest: string;
  readonly command: SideEffectDeliveryCommand;
};

export interface SideEffectPreparer {
  readonly ref: ToolRef;
  prepareEffect(
    input: AgentValue,
    context: ToolInvocationContext,
  ): Promise<PreparedEffect>;
}

export interface SideEffectToolImplementation extends SideEffectPreparer {
  readonly ref: ToolRef;
  readonly kind: 'side_effect';
  propose(input: AgentValue, context: ToolInvocationContext): Promise<void>;
  prepareEffect(
    input: AgentValue,
    context: ToolInvocationContext,
  ): Promise<PreparedEffect>;
}

export type AnyToolImplementation =
  ToolImplementation | SideEffectToolImplementation;

export function isSideEffectImplementation(
  implementation: AnyToolImplementation,
): implementation is SideEffectToolImplementation {
  return (
    'kind' in implementation &&
    (implementation as { kind?: unknown }).kind === 'side_effect'
  );
}

export const TOOL_FAILURE_CODES = [
  'implementation_error',
  'output_rejected',
  ...SIDE_EFFECT_PRECONDITION_CODES,
  'provider_rejected',
] as const;

export type ToolFailureCode = (typeof TOOL_FAILURE_CODES)[number];
