import type { Job } from 'bullmq';

import type { QueueName } from './queue.config';

export interface QueueJobHandler<TData = unknown> {
  readonly queue: QueueName;

  readonly jobName: string;

  handle(job: Job<TData>): Promise<void>;
}
