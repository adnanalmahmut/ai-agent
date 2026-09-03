import { z } from 'zod';

import type { SecretIo } from './secret-input';
import { isInteractive, readPassword, withoutSecret } from './secret-input';
import type {
  BootstrapOutcome,
  SuperAdminBootstrap,
} from './super-admin.bootstrap';

export const EXIT = {
  ok: 0,
  usage: 1,
  alreadyBootstrapped: 2,
  locked: 3,
  emailTaken: 4,
  failed: 5,
} as const;

const identitySchema = z.object({
  email: z.email('A valid --email is required'),
  name: z.preprocess(
    (value) => value ?? '',
    z.string().trim().min(1, 'A non-empty --name is required'),
  ),
});

export type ParsedArgs =
  { ok: true; email: string; name: string } | { ok: false; message: string };

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('--')) {
      return {
        ok: false,
        message: `Unexpected argument at position ${index + 1}`,
      };
    }

    const [flag, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
    const value = inlineValue ?? argv[++index];

    if (value === undefined) {
      return { ok: false, message: `Missing value for --${flag}` };
    }

    if (values.has(flag)) {
      // Last-wins is a silent answer to an ambiguous request, and every other
      // ambiguity here is refused.
      return { ok: false, message: `Repeated option: --${flag}` };
    }

    values.set(flag, value);
  }

  if (values.has('password')) {
    return {
      ok: false,
      message:
        'Refusing --password: it would be recorded in shell history and visible in the process list. Pipe it on stdin, or omit it to be prompted.',
    };
  }

  const parsed = identitySchema.safeParse({
    email: values.get('email'),
    name: values.get('name'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues.map((issue) => issue.message).join('; '),
    };
  }

  const unknown = [...values.keys()].filter(
    (flag) => flag !== 'email' && flag !== 'name',
  );

  if (unknown.length > 0) {
    return { ok: false, message: `Unknown option: --${unknown[0]}` };
  }

  return {
    ok: true,
    email: parsed.data.email.toLowerCase(),
    name: parsed.data.name,
  };
}

export const USAGE = `Usage: super-admin:create --email <address> --name <name>

Creates the platform's first super administrator. Works only while the platform
has none; afterwards, grant the role from the Platform as an existing
super administrator.

The password is never taken as an argument: it would be in your shell history
and visible in the process list. On a terminal you are prompted for it twice
without echo. Otherwise the first line of stdin is used, so a scripted bootstrap
should read it from a file, or with a shell builtin that does not echo — never
from a literal or an environment variable, both of which persist.
`;

export type CommandIo = SecretIo & { error: NodeJS.WritableStream };

export async function runSuperAdminCreate(
  argv: readonly string[],
  io: CommandIo,
  resolveBootstrap: () => Promise<Pick<SuperAdminBootstrap, 'run'>>,
): Promise<number> {
  const args = parseArgs(argv);

  if (!args.ok) {
    io.error.write(`${args.message}\n\n${USAGE}`);

    return EXIT.usage;
  }

  if (isInteractive(io)) {
    io.output.write(
      `Creating the first platform super administrator for ${args.email}.\n`,
    );
  }

  const password = await readPassword(io);

  if (!password.ok) {
    const explanation = {
      mismatch: 'The passwords did not match.',
      empty: 'A password is required.',
      // Reported explicitly, and non-zero. Silence plus a zero exit is how an
      // interrupted prompt would otherwise read as "account created".
      cancelled: 'Cancelled; no account was created.',
    }[password.reason];

    io.error.write(`${explanation}\n`);

    return EXIT.usage;
  }

  let outcome: BootstrapOutcome;

  try {
    const bootstrap = await resolveBootstrap();

    outcome = await bootstrap.run({
      email: args.email,
      name: args.name,
      password: password.password,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';

    io.error.write(
      `Could not create the super administrator: ${withoutSecret(
        message,
        password.password,
      )}\n`,
    );

    return EXIT.failed;
  }

  switch (outcome.status) {
    case 'created':
      io.output.write(
        `Created super administrator ${outcome.email} (${outcome.userId}).\n` +
          'Sign in through the Platform; the address is already verified.\n',
      );

      return EXIT.ok;

    case 'already-bootstrapped':
      io.error.write(
        `This platform already has ${outcome.existingCount} super administrator(s).\n` +
          'Grant the role from the Platform instead; this command only bootstraps an empty platform.\n',
      );

      return EXIT.alreadyBootstrapped;

    case 'locked':
      io.error.write(
        'Another bootstrap is already running against this database. Wait for it to finish, then re-check.\n',
      );

      return EXIT.locked;

    case 'email-taken':
      io.error.write(
        'An account with that email already exists. Choose another address, or grant it the role once a super administrator exists.\n',
      );

      return EXIT.emailTaken;

    case 'password-rejected':
      io.error.write(
        `The password must be between ${outcome.minLength} and ${outcome.maxLength} characters.\n`,
      );

      return EXIT.usage;
  }
}
