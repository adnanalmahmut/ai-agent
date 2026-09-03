import type {
  MailDeliveryResult,
  MailDriver,
  OutboundMail,
} from './mail.types';

export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

export interface MailTransport {
  send(mail: OutboundMail): Promise<MailDeliveryResult>;
}

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

export function formatSender(from: { address: string; name: string }): string {
  const escaped = from.name.replace(/(["\\])/g, '\\$1');

  return /[",;:<>@[\]\\]/.test(from.name)
    ? `"${escaped}" <${from.address}>`
    : `${from.name} <${from.address}>`;
}

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
