import type { ExternalEffectOutcome } from '../../core/external-effect';
import type { SideEffectDeliveryCommand } from './tool.types';

export { type SideEffectDeliveryCommand } from './tool.types';

export const SIDE_EFFECT_DELIVERY = Symbol('SIDE_EFFECT_DELIVERY');

export interface SideEffectDeliveryPort {
  deliver(
    command: SideEffectDeliveryCommand,
    idempotencyKey: string,
  ): Promise<ExternalEffectOutcome>;
}
