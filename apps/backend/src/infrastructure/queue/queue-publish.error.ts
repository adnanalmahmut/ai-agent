export type PublishFailureKind = 'transient' | 'permanent';

const PERMANENT_SIGNATURES: RegExp[] = [
  // JSON.stringify on the job payload, from `Job.addJob`.
  /circular structure/i,
  /do not know how to serialize/i,
  /bigint/i,
  // BullMQ's own `sizeLimit` guard: "The size of job X exceeds the limit N bytes".
  /exceeds the limit/i,
];

export function classifyPublishError(error: unknown): PublishFailureKind {
  const message = error instanceof Error ? error.message : String(error);

  return PERMANENT_SIGNATURES.some((pattern) => pattern.test(message))
    ? 'permanent'
    : 'transient';
}

export class QueuePublishError extends Error {
  readonly kind: PublishFailureKind;

  constructor(
    readonly queue: string,
    readonly reason: 'timeout' | 'rejected',
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'QueuePublishError';

    this.kind =
      reason === 'timeout'
        ? 'transient'
        : classifyPublishError(cause ?? message);
  }
}
