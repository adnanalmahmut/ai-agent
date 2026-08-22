import { z } from 'zod';

import type { SecretIo } from './secret-input';
import { isInteractive, readPassword, withoutSecret } from './secret-input';
import type {
  BootstrapOutcome,
  SuperAdminBootstrap,
} from './super-admin.bootstrap';

/**
 * Exit codes, fixed and documented.
 *
 * An operator command is scripted eventually, and a script can only branch on
 * the number. They are distinct per failure so a bootstrap that has already
 * happened is distinguishable from one that collided with another operator,
 * which is distinguishable from a bad argument.
 */
export const EXIT = {
  ok: 0,
  usage: 1,
  alreadyBootstrapped: 2,
  locked: 3,
  emailTaken: 4,
  failed: 5,
} as const;

/**
 * The identity half of the request, validated at the boundary like any other
 * input. The password is deliberately absent: it never arrives as an argument,
 * so it is never parsed here, and its length is checked later against the
 * deployment's configured policy — read from Better Auth rather than restated,
 * because the endpoint that creates the account does not enforce it. See
 * `resolvePasswordPolicy`.
 */
const identitySchema = z.object({
  email: z.email('A valid --email is required'),
  /**
   * The missing case is normalized to an empty string so one rule answers both
   * of them. Without it a bare `min(1, ...)` reports its custom message for
   * `--name ''` and Zod's own "expected string, received undefined" for an
   * omitted flag — two different explanations of the same operator mistake, one
   * of them about the validator rather than the command.
   */
  name: z.preprocess(
    (value) => value ?? '',
    z.string().trim().min(1, 'A non-empty --name is required'),
  ),
});

export type ParsedArgs =
  { ok: true; email: string; name: string } | { ok: false; message: string };

/**
 * Parses `--email` and `--name`.
 *
 * Hand-rolled rather than pulling in a CLI framework: two flags do not justify
 * a dependency, and the repository has no CLI framework to be consistent with.
 * If a third command arrives with real subcommand structure, that is the moment
 * to reconsider — not before.
 *
 * `--password` is rejected rather than ignored. Silently dropping it would let
 * an operator believe a password had been supplied while the command waited on
 * stdin, and the flag they typed would already be in their shell history.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('--')) {
      /**
       * The position, never the value. Every other refusal here is careful not
       * to repeat what it was given, because the operator's scrollback and any
       * CI log are two of the three places this module exists to keep a
       * password out of — and a stray positional is exactly how a password
       * arrives unquoted.
       */
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

  /**
   * Lowercased because Better Auth lowercases before its own lookup. Without
   * this, `--email OPS@Example.com` against an existing `ops@example.com` slips
   * past the pre-check and is refused by the library instead, which surfaces as
   * the generic failure code rather than the documented "email already taken"
   * one — a script branching on the exit code would get the wrong answer.
   */
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

/**
 * Runs the command and returns an exit code.
 *
 * Separated from the process entrypoint so a test can drive it with fake
 * streams and a fake bootstrap, and assert both the code and — the part that
 * matters most here — everything that was written to the two output streams.
 *
 * The bootstrap arrives as a thunk rather than a value because resolving it
 * boots a Nest context and opens a database connection. A mistyped flag or a
 * mismatched password confirmation should cost neither: those are answerable
 * from the arguments alone, and an operator repairing a broken deployment
 * should be able to run `--help` and see a usage error without a reachable
 * database. It also means a test can assert that a usage error never touched
 * the database at all.
 */
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
    /**
     * Only the message, never the error object — and then the password removed
     * from that message.
     *
     * Dropping the stack and the cause is not sufficient, which is the whole
     * lesson of this block. A rejected Better Auth call quotes the offending
     * request body, and that body holds the plaintext password, so the message
     * this handler deliberately preserves for diagnosability is itself the
     * leak. A canary test proved it; reading the code had not.
     */
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
