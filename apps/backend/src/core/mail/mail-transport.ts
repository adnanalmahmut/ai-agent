import type {
  MailDeliveryResult,
  MailDriver,
  OutboundMail,
} from './mail.types';

/**
 * Injection token for the configured delivery driver.
 *
 * Intentionally **not** re-exported from `index.ts`. The module's public
 * surface is `MailService`; if consumers could inject this they could send a
 * message that skipped rendering, locale resolution, and the failure handling
 * that `MailService` exists to provide.
 */
export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

/**
 * Everything a delivery driver has to do, and nothing else.
 *
 * One method, one argument. No `getQuota()`, no `supportsAttachments()`, no
 * provider options bag — the moment this interface grows a member that only
 * one provider can implement, transports stop being substitutable and the
 * abstraction has failed.
 */
export interface MailTransport {
  send(mail: OutboundMail): Promise<MailDeliveryResult>;
}

/**
 * Raised by a transport when delivery fails.
 *
 * `cause` is a debugging aid and is deliberately *not* part of anything that
 * gets logged: provider SDK errors routinely carry the full request — headers,
 * query strings, sometimes the API key that signed it. `MailService` logs a
 * fixed safe projection instead, and `cause` stays reachable in a debugger and
 * on the rejection from `send()`.
 */
export class MailDeliveryError extends Error {
  constructor(
    readonly provider: MailDriver,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MailDeliveryError';
  }
}

/**
 * RFC 5322 sender, as every provider wants it: `Display Name <addr@host>`.
 *
 * The display name is quoted when it contains a character that would otherwise
 * terminate the phrase, so a configured name like `Acme, Inc.` cannot alter the
 * meaning of the header.
 */
export function formatSender(from: { address: string; name: string }): string {
  const escaped = from.name.replace(/(["\\])/g, '\\$1');

  return /[",;:<>@[\]\\]/.test(from.name)
    ? `"${escaped}" <${from.address}>`
    : `${from.name} <${from.address}>`;
}

/**
 * Bounds how long a delivery attempt is waited on.
 *
 * Honest about what this does and does not do: it stops `dispatch` from
 * holding a promise open indefinitely when a provider stalls, but it cannot
 * abort an HTTP request or a socket that the SDK owns — the underlying work
 * may still complete after the rejection. That trade-off is acceptable here
 * because the caller is fire-and-forget; a duplicate send is a far smaller
 * problem than a promise that never settles.
 */
export function withTimeout<T>(
  work: Promise<T>,
  milliseconds: number,
  onTimeout: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), milliseconds);

    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
