import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { QUEUE_NAMES, type QueueJobHandler } from '../../infrastructure/queue';
import { DeliverApprovedToolEffectUseCase } from '../../modules/approvals';

export type SideEffectExecutionJob = {
  toolExecutionId: string;
  organizationId: string;
};

export const SIDE_EFFECT_ATTEMPT_FAILED = 'Side-effect delivery attempt failed';

/**
 * The queue side of performing an approved side effect. It says which row a
 * delivery is for and whether another delivery follows, records what the
 * Control Plane decided, and rejects the job when the row is not settled.
 *
 * It holds no authority: it cannot see an approval, a grant, an organization,
 * or a provider, and there is nothing it could put in a job payload that would
 * let it perform an effect that was not authorized.
 */
@Injectable()
export class SideEffectExecutionHandler implements QueueJobHandler<SideEffectExecutionJob> {
  readonly queue = QUEUE_NAMES.toolSideEffect;
  readonly jobName = 'deliver';

  constructor(
    private readonly delivery: DeliverApprovedToolEffectUseCase,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SideEffectExecutionHandler.name);
  }

  async handle(job: Job<SideEffectExecutionJob>): Promise<void> {
    const { toolExecutionId, organizationId } = job.data ?? {};

    if (
      typeof toolExecutionId !== 'string' ||
      toolExecutionId.length === 0 ||
      typeof organizationId !== 'string' ||
      organizationId.length === 0
    ) {
      throw new Error(
        'Side-effect job requires toolExecutionId and organizationId',
      );
    }

    const outcome = await this.delivery.execute({
      toolExecutionId,
      organizationId,
      lastDelivery: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
    });

    for (const record of outcome.records) {
      this.logger.info(
        {
          toolExecutionId,
          attemptsStarted: job.attemptsStarted,
          attemptsMade: job.attemptsMade,
          reason: record.reason,
          ...(record.status ? { status: record.status } : {}),
          ...(record.failureCode ? { failureCode: record.failureCode } : {}),
        },
        'Side-effect delivery',
      );
    }

    if (outcome.status === 'complete') return;

    // BullMQ must see a rejection to redeliver, and provider messages must not
    // be copied into Redis failedReason or logs.
    throw new Error(SIDE_EFFECT_ATTEMPT_FAILED);
  }
}
