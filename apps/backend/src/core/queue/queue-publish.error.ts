/**
 * Whether retrying this publish could ever succeed.
 *
 * The distinction decides whether durably accepted work survives an outage, so
 * it is a policy and not a detail:
 *
 *   transient  The queue transport is unwell — unreachable, reconnecting,
 *              timing out, out of memory. Nothing about the event is wrong, and
 *              the same publish will succeed once Redis is back. Retried
 *              indefinitely with capped backoff.
 *   permanent  The publish is deterministically impossible: a payload that
 *              cannot be serialised, a job larger than the configured limit.
 *              The thousandth attempt fails exactly like the first.
 */
export type PublishFailureKind = 'transient' | 'permanent';

/**
 * Signatures of failures that will never succeed on a retry.
 *
 * An allowlist, not a denylist, and that asymmetry is the whole safety
 * property. Anything unrecognised is treated as transient, because the cost of
 * the two mistakes is not symmetric: misclassifying a poison event as transient
 * wastes a retry every backoff interval and leaves a row visibly stuck, while
 * misclassifying a transport outage as permanent destroys work the API already
 * told a caller it had accepted.
 */
const PERMANENT_SIGNATURES: RegExp[] = [
  // JSON.stringify on the job payload, from `Job.addJob`.
  /circular structure/i,
  /do not know how to serialize/i,
  /bigint/i,
  // BullMQ's own `sizeLimit` guard: "The size of job X exceeds the limit N bytes".
  /exceeds the limit/i,
];

/**
 * Classifies a publish failure.
 *
 * Deliberately does not enumerate transient signatures. Listing
 * `ECONNREFUSED`, `ECONNRESET`, `MaxRetriesPerRequestError`, `Command timed
 * out`, `Connection is closed`, `Stream isn't writeable`, `OOM`, `LOADING`,
 * `CLUSTERDOWN` and the rest would be a list that is wrong the first time a
 * driver rewords a message — and being wrong in *that* direction means parking
 * accepted work during an outage. Unknown means transient, on purpose.
 */
export function classifyPublishError(error: unknown): PublishFailureKind {
  const message = error instanceof Error ? error.message : String(error);

  return PERMANENT_SIGNATURES.some((pattern) => pattern.test(message))
    ? 'permanent'
    : 'transient';
}

/**
 * A publish that did not happen.
 *
 * Its own type because the caller's correct reaction is specific and not
 * obvious: for a transient failure the outbox dispatcher must *keep* the event
 * and retry it later, however many times that takes. Treating this as a generic
 * failure — logging it and marking the event delivered, or letting it escape as
 * an unhandled rejection — is how at-least-once delivery silently becomes
 * at-most-once.
 */
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

    /**
     * A timeout is transport by definition — it says the queue did not answer,
     * which is not a statement about the event. Everything else is classified
     * from the underlying error.
     */
    this.kind =
      reason === 'timeout'
        ? 'transient'
        : classifyPublishError(cause ?? message);
  }
}
