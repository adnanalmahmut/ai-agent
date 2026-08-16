import { registerAs } from '@nestjs/config';
import { z } from 'zod';

// Imported from the module file rather than the `core/mail` barrel on purpose:
// the barrel pulls in `mail.module.ts`, which imports this config back, and the
// cycle would resolve to `undefined` at load time. `mail.types.ts` is a leaf.
import { MAIL_DRIVERS } from '../core/mail/mail.types';

type MailFrom = {
  address: string;
  name: string;
};

/**
 * Per-driver configuration, discriminated on `driver`.
 *
 * Provider-specific fields live on their own branch, so `config.apiKey` is
 * unreachable until the driver has been narrowed. Adding a provider means
 * adding a member here — not widening a shared bag of optional fields.
 */
export type LogMailConfig = {
  driver: 'log';
  from: MailFrom;
  /** Development aid: also write the rendered HTML to `.tmp/mail/`. */
  writeHtml: boolean;
};

export type ResendMailConfig = {
  driver: 'resend';
  from: MailFrom;
  apiKey: string;
  timeoutMs: number;
};

export type SesMailConfig = {
  driver: 'ses';
  from: MailFrom;
  region: string;
  /**
   * Explicit static credentials, or `undefined` to let the AWS SDK resolve
   * them itself. Leaving this unset is the *preferred* deployment shape: an
   * IAM role on ECS/EKS/EC2 hands out short-lived credentials, which is
   * strictly better than long-lived keys in the environment.
   */
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  timeoutMs: number;
};

export type SmtpMailConfig = {
  driver: 'smtp';
  from: MailFrom;
  host: string;
  port: number;
  secure: boolean;
  /** Absent for unauthenticated relays, which are common in local testing. */
  auth?: { user: string; password: string };
  timeoutMs: number;
};

export type MailConfig =
  LogMailConfig | ResendMailConfig | SesMailConfig | SmtpMailConfig;

/**
 * Settings every driver needs. Parsed unconditionally.
 *
 * `MAIL_DRIVER` only accepts drivers that are actually implemented, so a
 * typo or an aspirational value fails at boot with the list of real options
 * rather than at the first send with a missing provider.
 */
const baseSchema = z.object({
  MAIL_DRIVER: z
    .enum(MAIL_DRIVERS, {
      error: () => `MAIL_DRIVER must be one of: ${MAIL_DRIVERS.join(', ')}`,
    })
    .default('log'),

  MAIL_FROM_ADDRESS: z.email(),

  MAIL_FROM_NAME: z.string().min(1).default('API Service'),
});

const logSchema = z.object({
  MAIL_LOG_WRITE_HTML: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .default(false),
});

/**
 * An optional credential, where "left blank" means "not set".
 *
 * `.env` files habitually carry `SMTP_USER=` for a value the operator does not
 * use. Without this, that empty string counts as *present* and fails a
 * `min(1)` check with a confusing "too small" error — or worse, half-satisfies
 * a paired-credentials rule. Blank and absent are the same intent here.
 *
 * Deliberately not applied to *required* secrets: `RESEND_API_KEY=` must still
 * fail loudly rather than be quietly treated as missing configuration.
 */
const optionalSecret = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);

/** How long any real provider may be waited on before the attempt is failed. */
const timeoutSchema = z.coerce
  .number()
  .int()
  .min(1000)
  .max(120_000)
  .default(10_000);

const resendSchema = z.object({
  RESEND_API_KEY: z.string().min(1, 'RESEND_API_KEY must not be empty'),
  MAIL_TIMEOUT_MS: timeoutSchema,
});

/**
 * SES requires a region and nothing else.
 *
 * Credentials are deliberately optional: the AWS SDK resolves them through its
 * own chain (environment, SSO, shared config, then the container/instance
 * metadata service), so a deployment using an IAM task role must not be forced
 * to invent static keys. If a key *is* supplied, its secret is required too —
 * a half-configured pair is a mistake worth failing on rather than silently
 * falling through to the chain.
 */
const sesSchema = z
  .object({
    AWS_REGION: z.string().min(1, 'AWS_REGION is required for the ses driver'),
    AWS_ACCESS_KEY_ID: optionalSecret,
    AWS_SECRET_ACCESS_KEY: optionalSecret,
    AWS_SESSION_TOKEN: optionalSecret,
    MAIL_TIMEOUT_MS: timeoutSchema,
  })
  .refine(
    (env) =>
      Boolean(env.AWS_ACCESS_KEY_ID) === Boolean(env.AWS_SECRET_ACCESS_KEY),
    {
      error:
        'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together, or both omitted to use the AWS default credential chain',
    },
  );

/**
 * SMTP auth is optional so a local or containerised relay (MailHog, Mailpit)
 * works without credentials, but a username without a password is a
 * misconfiguration rather than a valid anonymous session.
 */
const smtpSchema = z
  .object({
    SMTP_HOST: z.string().min(1, 'SMTP_HOST is required for the smtp driver'),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_SECURE: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .default(false),
    SMTP_USER: optionalSecret,
    SMTP_PASSWORD: optionalSecret,
    MAIL_TIMEOUT_MS: timeoutSchema,
  })
  .refine((env) => Boolean(env.SMTP_USER) === Boolean(env.SMTP_PASSWORD), {
    error:
      'SMTP_USER and SMTP_PASSWORD must be set together, or both omitted for an unauthenticated relay',
  });

/**
 * Only the *active* driver's schema is ever parsed.
 *
 * That is the whole point of the switch: running with `MAIL_DRIVER=log` must
 * not require a `RESEND_API_KEY`, while running with `MAIL_DRIVER=resend` and
 * no key must refuse to boot rather than fail on the first password reset.
 */
export default registerAs('mail', (): MailConfig => {
  const base = baseSchema.parse(process.env);

  const from: MailFrom = {
    address: base.MAIL_FROM_ADDRESS,
    name: base.MAIL_FROM_NAME,
  };

  switch (base.MAIL_DRIVER) {
    case 'log': {
      const env = logSchema.parse(process.env);

      return { driver: 'log', from, writeHtml: env.MAIL_LOG_WRITE_HTML };
    }

    case 'resend': {
      const env = resendSchema.parse(process.env);

      return {
        driver: 'resend',
        from,
        apiKey: env.RESEND_API_KEY,
        timeoutMs: env.MAIL_TIMEOUT_MS,
      };
    }

    case 'ses': {
      const env = sesSchema.parse(process.env);

      return {
        driver: 'ses',
        from,
        region: env.AWS_REGION,
        credentials:
          env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
            ? {
                accessKeyId: env.AWS_ACCESS_KEY_ID,
                secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
                sessionToken: env.AWS_SESSION_TOKEN,
              }
            : undefined,
        timeoutMs: env.MAIL_TIMEOUT_MS,
      };
    }

    case 'smtp': {
      const env = smtpSchema.parse(process.env);

      return {
        driver: 'smtp',
        from,
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth:
          env.SMTP_USER && env.SMTP_PASSWORD
            ? { user: env.SMTP_USER, password: env.SMTP_PASSWORD }
            : undefined,
        timeoutMs: env.MAIL_TIMEOUT_MS,
      };
    }
  }
});
