import { Resend } from 'resend';

import type { ResendMailConfig } from '../../config/mail.config';
import { formatSender, withTimeout } from './mail-transport';
import type {
  ExternalEffectOutcome,
  NotificationDelivery,
  NotificationMessage,
} from './notification-delivery';

/**
 * Governed delivery through Resend, with the provider's idempotency key.
 *
 * What the installed `resend@6.20.0` and Resend's documentation say, read
 * rather than assumed, because the whole retry contract rests on it:
 *
 * - `emails.send(payload, { idempotencyKey })` sets the `Idempotency-Key`
 *   header. The key may be up to 256 characters and is kept for 24 hours.
 * - The same key with the same payload inside that window replays the
 *   original response — the same email id — without sending again.
 * - The same key with a different payload is `409 invalid_idempotent_request`
 *   and nothing is sent. A concurrent request holding the same key is
 *   `409 concurrent_idempotent_requests`; the caller should try again later.
 * - The SDK does not throw on an API error. It resolves `{ data, error }`, so
 *   the error branch is checked explicitly and `catch` covers only transport
 *   failures.
 *
 * Nothing from `error` but its stable `name` and `statusCode` is read, and
 * neither is returned: they select a classification, and the classification
 * is what leaves. `error.message` can quote the payload it rejected, which is
 * the recipient and the message text.
 */
export class ResendNotificationDelivery implements NotificationDelivery {
  readonly idempotent = true;
  readonly sender: string;

  private readonly client: Resend;

  constructor(private readonly config: ResendMailConfig) {
    this.client = new Resend(config.apiKey);
    this.sender = formatSender(config.from);
  }

  async deliver(message: NotificationMessage): Promise<ExternalEffectOutcome> {
    let response: Awaited<ReturnType<Resend['emails']['send']>>;

    try {
      response = await withTimeout(
        this.client.emails.send(
          {
            from: this.sender,
            to: [message.to],
            subject: message.subject,
            html: message.html,
            text: message.text,
          },
          { idempotencyKey: message.idempotencyKey },
        ),
        this.config.timeoutMs,
        () => new Error('Resend did not respond in time'),
      );
    } catch {
      /**
       * A timeout or a transport failure. The request may have reached the
       * provider — a timeout in particular says nothing about whether the
       * message was accepted — so this is `unavailable`, never `rejected`.
       * The caught value is not read.
       */
      return { kind: 'unavailable' };
    }

    if (response.error) {
      return classify(response.error.name, response.error.statusCode);
    }

    if (!response.data?.id) {
      // A success with no identifier is a response this application cannot
      // reconstruct anything from. Treated as ambiguous rather than as sent.
      return { kind: 'unavailable' };
    }

    return { kind: 'accepted', providerMessageId: response.data.id };
  }
}

/**
 * Deterministic refusals, by Resend's stable error code.
 *
 * Everything not listed is `unavailable`: a 5xx, a rate limit, a quota, a
 * concurrent duplicate, and any code this version does not know. The default
 * is the conservative one, because `rejected` asserts that nothing was sent
 * and that a retry with the same payload would be refused again. An unknown
 * code cannot support that claim.
 *
 * `invalid_idempotent_request` is deliberately *not* here. Resend answers it
 * only when an earlier request with this key was accepted and this one's
 * payload differs — so the message was sent, by the earlier attempt whose
 * answer was lost. This request sent nothing, but "nothing was sent" is false
 * for the execution, and `rejected` would let the worker write `FAILED` over a
 * delivered message. It is `unavailable`, which the worker resolves to
 * `OUTCOME_UNKNOWN` on its last attempt. The tool's payload digest covers the
 * sender and the rendered body so this branch is not reached by a deploy-time
 * change; if it is reached anyway, unknown is the honest answer.
 */
const REJECTED: ReadonlySet<string> = new Set([
  'validation_error',
  'missing_required_field',
  'invalid_parameter',
  'invalid_from_address',
  'invalid_attachment',
  'invalid_idempotency_key',
  'missing_api_key',
  'invalid_api_key',
  'restricted_api_key',
  'invalid_access',
  'not_found',
  'method_not_allowed',
  'invalid_region',
]);

function classify(
  name: string,
  statusCode: number | null,
): ExternalEffectOutcome {
  if (REJECTED.has(name)) return { kind: 'rejected' };

  /**
   * A 4xx this version does not recognise by name is still a client error
   * the provider chose to refuse — except 409 and 429, which are the two
   * codes whose meaning is "not now" rather than "not this".
   */
  if (
    statusCode !== null &&
    statusCode >= 400 &&
    statusCode < 500 &&
    statusCode !== 409 &&
    statusCode !== 429
  ) {
    return { kind: 'rejected' };
  }

  return { kind: 'unavailable' };
}
