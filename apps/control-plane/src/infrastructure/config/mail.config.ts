import { registerAs } from '@nestjs/config';
import { z } from 'zod';

// Imported from the module file rather than the `infrastructure/mail` barrel on purpose:
// the barrel pulls in `mail.module.ts`, which imports this config back, and the
// cycle would resolve to `undefined` at load time. `mail.types.ts` is a leaf.
import { MAIL_DRIVERS } from '../mail/mail.types';

type MailFrom = {
  address: string;
  name: string;
};

export type LogMailConfig = {
  driver: 'log';
  from: MailFrom;
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
  auth?: { user: string; password: string };
  timeoutMs: number;
};

export type MailConfig =
  LogMailConfig | ResendMailConfig | SesMailConfig | SmtpMailConfig;

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

const optionalSecret = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);

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
