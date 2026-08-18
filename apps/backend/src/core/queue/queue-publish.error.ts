/**
 * A publish that did not happen.
 *
 * Its own type because the caller's correct reaction is specific and not
 * obvious: the outbox dispatcher must *keep* the event and let its lease expire
 * so a later pass re-publishes it. Treating this as a generic failure — logging
 * it and marking the event delivered, or letting it escape as an unhandled
 * rejection — is how at-least-once delivery silently becomes at-most-once.
 */
export class QueuePublishError extends Error {
  constructor(
    readonly queue: string,
    readonly reason: 'timeout' | 'rejected',
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'QueuePublishError';
  }
}
