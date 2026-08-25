import { PassThrough, Readable, Writable } from 'node:stream';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type {
  BootstrapOutcome,
  BootstrapRequest,
} from '../super-admin.bootstrap';
import {
  EXIT,
  USAGE,
  parseArgs,
  runSuperAdminCreate,
  type CommandIo,
} from '../super-admin.command';

/**
 * The command's judgement, with no database and no Better Auth behind it.
 *
 * Two things are decided here and nowhere else: what an operator is refused
 * before any work starts, and what the two output streams are allowed to
 * contain afterwards. Both are security properties rather than ergonomics —
 * accepting `--password` writes the platform-owning credential into shell
 * history, and printing a rejected call's stack writes it onto the terminal —
 * so they are asserted directly against the bytes written rather than through
 * the outcome the caller sees.
 */

/** Distinctive enough that one occurrence anywhere in the output is provable. */
const CANARY = 'CANARY-P4ssw0rd-do-not-log';

class CaptureStream extends Writable {
  private readonly parts: string[] = [];

  onWrite: ((text: string) => void) | undefined = undefined;

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text = Buffer.isBuffer(chunk)
      ? chunk.toString('utf8')
      : typeof chunk === 'string'
        ? chunk
        : '';

    this.parts.push(text);
    this.onWrite?.(text);
    callback();
  }

  get text(): string {
    return this.parts.join('');
  }
}

type TestIo = CommandIo & { output: CaptureStream; error: CaptureStream };

/** Stdin as a pipe carrying one password, which is the automation shape. */
const pipedIo = (password: string): TestIo => ({
  input: Readable.from([Buffer.from(password, 'utf8')]),
  output: new CaptureStream(),
  error: new CaptureStream(),
});

/** Stdin as a terminal that types the same answer at every prompt. */
const ttyIo = (...answers: string[]): TestIo => {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;

  const output = new CaptureStream();
  const pending = [...answers];

  output.onWrite = (text) => {
    if (!text.includes('assword: ')) return;

    const next = pending.shift();

    if (next === undefined) return;

    setImmediate(() => input.write(`${next}\n`));
  };

  return { input, output, error: new CaptureStream() };
};

/** Ctrl+C. Raw mode has disabled ISIG, so readline sees the key, not a signal. */
const CTRL_C = '\u0003';

/**
 * Stdin as a terminal that types `typed` and then interrupts instead of
 * pressing return, which is what Ctrl+C at a password prompt looks like.
 */
const interruptedIo = (typed = ''): TestIo => {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;

  const output = new CaptureStream();

  output.onWrite = (text) => {
    if (!text.includes('assword: ')) return;

    setImmediate(() => {
      if (typed.length > 0) input.write(typed);
      input.write(CTRL_C);
    });
  };

  return { input, output, error: new CaptureStream() };
};

const ARGS = ['--email', 'ops@example.com', '--name', 'Ops'] as const;

describe('parseArgs', () => {
  it('accepts an email and a name given as separate tokens', () => {
    expect(parseArgs([...ARGS])).toEqual({
      ok: true,
      email: 'ops@example.com',
      name: 'Ops',
    });
  });

  /** `--flag=value` is how a script writes it; both forms must mean the same. */
  it('accepts the inline --flag=value form', () => {
    expect(parseArgs(['--email=ops@example.com', '--name=Ops Team'])).toEqual({
      ok: true,
      email: 'ops@example.com',
      name: 'Ops Team',
    });
  });

  /** An `=` inside the value belongs to the value, not to the split. */
  it('keeps everything after the first = as the value', () => {
    expect(parseArgs(['--email=ops@example.com', '--name=A=B'])).toEqual({
      ok: true,
      email: 'ops@example.com',
      name: 'A=B',
    });
  });

  /**
   * The address is the account's identity and its only recovery channel, so a
   * typo has to be refused here rather than produce an unreachable owner.
   */
  it('refuses a malformed email', () => {
    expect(parseArgs(['--email', 'not-an-email', '--name', 'Ops'])).toEqual({
      ok: false,
      message: expect.stringContaining('A valid --email is required'),
    });
  });

  it('refuses a missing email', () => {
    expect(parseArgs(['--name', 'Ops'])).toEqual({
      ok: false,
      message: expect.stringContaining('A valid --email is required'),
    });
  });

  /**
   * An omitted flag and an empty one are the same operator mistake, so they get
   * the same sentence. The wording is pinned because the alternative is what
   * this originally did: report Zod's "expected string, received undefined" for
   * the omitted case, which explains the validator rather than the command and
   * differs from the message the very same mistake produces one keystroke away.
   */
  it('refuses a missing name with the same message as an empty one', () => {
    expect(parseArgs(['--email', 'ops@example.com'])).toEqual({
      ok: false,
      message: 'A non-empty --name is required',
    });
  });

  /** Whitespace is not a name; `trim` is what makes that true. */
  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
  ])('refuses a %s name', (_label, name) => {
    expect(parseArgs(['--email', 'ops@example.com', '--name', name])).toEqual({
      ok: false,
      message: 'A non-empty --name is required',
    });
  });

  /**
   * Lowercased at the boundary because Better Auth lowercases before its own
   * lookup. Without it, `--email OPS@Example.com` against an existing
   * `ops@example.com` slips past the pre-check and is refused by the library
   * instead — which surfaces as the generic failure code rather than the
   * documented "email already taken" one, so a script branching on the exit
   * code is told the wrong thing.
   */
  it.each([
    ['a mixed-case address', 'OPS@Example.com'],
    ['an upper-case address', 'OPS@EXAMPLE.COM'],
  ])('lowercases %s', (_label, address) => {
    expect(parseArgs(['--email', address, '--name', 'Ops'])).toEqual({
      ok: true,
      email: 'ops@example.com',
      name: 'Ops',
    });
  });

  /** The name is the operator's own text and is left exactly as typed. */
  it('does not change the case of the name', () => {
    expect(parseArgs(['--email=ops@example.com', '--name=Ops McOps'])).toEqual({
      ok: true,
      email: 'ops@example.com',
      name: 'Ops McOps',
    });
  });

  /**
   * Refused rather than resolved by last-wins. Two `--email` flags is an
   * ambiguous request, and the command's one action is irreversible enough that
   * guessing which one the operator meant is worse than making them say — the
   * usual way this arises is an edited shell-history line where the old value
   * was never removed.
   */
  it.each([
    ['--email', ['--email', 'a@example.com', '--email', 'b@example.com']],
    ['--name', ['--name', 'First', '--name', 'Second']],
  ])('refuses a repeated %s', (flag, argv) => {
    expect(parseArgs(argv)).toEqual({
      ok: false,
      message: `Repeated option: ${flag}`,
    });
  });

  /** Including when the two occurrences are written in different forms. */
  it('refuses a repeat that mixes the inline and separate forms', () => {
    expect(
      parseArgs(['--email=a@example.com', '--email', 'b@example.com']),
    ).toEqual({ ok: false, message: 'Repeated option: --email' });
  });

  it('refuses a flag with no value', () => {
    expect(parseArgs(['--email', 'ops@example.com', '--name'])).toEqual({
      ok: false,
      message: 'Missing value for --name',
    });
  });

  /**
   * An unknown flag is a misunderstanding, and this command's one action is
   * irreversible enough that acting on a misunderstood invocation is worse than
   * refusing it. `--role` in particular reads as if it would work.
   */
  it('refuses an unknown flag', () => {
    expect(parseArgs([...ARGS, '--role', 'admin'])).toEqual({
      ok: false,
      message: 'Unknown option: --role',
    });
  });

  /**
   * Reported by position, never by value. A stray positional is exactly how a
   * password arrives unquoted — `super-admin:create --email a@b.com --name X
   * hunter2` — and echoing it back would write the secret into the operator's
   * scrollback and into any CI log, in the very message that refuses it.
   */
  it('refuses a positional argument without repeating it', () => {
    expect(parseArgs(['create', ...ARGS])).toEqual({
      ok: false,
      message: 'Unexpected argument at position 1',
    });
  });

  /** The position is the one the operator can count to, not a zero-based index. */
  it('reports the position of a trailing positional', () => {
    expect(parseArgs([...ARGS, 'stray'])).toEqual({
      ok: false,
      message: 'Unexpected argument at position 5',
    });
  });

  /**
   * The rejection of `--password` is a security control, not a matter of
   * taste. Accepting it would write the platform-owning credential into shell
   * history and expose it in `ps` for the lifetime of the process; *ignoring*
   * it would be worse still, because the operator would believe a password had
   * been supplied while the command sat waiting on stdin — and the flag they
   * typed would already be recorded.
   *
   * The message has to say why, since an operator who is merely told "unknown
   * option" will reach for an environment variable next, which persists in
   * `/proc/<pid>/environ` just as durably.
   */
  it.each([
    ['as a separate token', ['--password', 'hunter2']],
    ['in the inline form', ['--password=hunter2']],
  ])('refuses --password %s', (_label, passwordArgs) => {
    const result = parseArgs([...ARGS, ...passwordArgs]);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toMatch(/shell history/i);
  });

  /**
   * Refused before the identity is even validated: an operator who typed a
   * password on the command line must be told about *that*, not sent to fix an
   * email address and retype the same unsafe invocation.
   */
  it('refuses --password before reporting anything else wrong', () => {
    const result = parseArgs(['--password', 'hunter2']);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toMatch(/shell history/i);
    expect(result.ok ? '' : result.message).not.toMatch(/--email/);
  });

  /** Not smuggled past the check by the flag that is otherwise accepted. */
  it('refuses --password even alongside a valid identity', () => {
    const result = parseArgs([
      '--email=ops@example.com',
      '--name=Ops',
      '--password=x',
    ]);

    expect(result.ok).toBe(false);
    // For the stated reason, not as a generic unknown option: deleting the
    // check would still refuse this invocation, and only the reason says why.
    expect(result.ok ? '' : result.message).toMatch(/shell history/i);
  });
});

describe('runSuperAdminCreate', () => {
  const run =
    jest.fn<(request: BootstrapRequest) => Promise<BootstrapOutcome>>();
  const bootstrap = { run };
  const resolveBootstrap = jest.fn(() => Promise.resolve(bootstrap));

  const created: BootstrapOutcome = {
    status: 'created',
    userId: 'user-1',
    email: 'ops@example.com',
  };

  beforeEach(() => {
    run.mockReset().mockResolvedValue(created);
    resolveBootstrap.mockClear();
  });

  describe('refusals before any work', () => {
    it('exits with the usage code and prints usage for a bad argument', async () => {
      const io = pipedIo('pw');

      const code = await runSuperAdminCreate(
        ['--email', 'nope'],
        io,
        resolveBootstrap,
      );

      expect(code).toBe(EXIT.usage);
      expect(io.error.text).toContain(USAGE);
      expect(io.output.text).toBe('');
      // Nothing may be attempted on an invocation that was not understood.
      expect(run).not.toHaveBeenCalled();
    });

    it('exits with the usage code when the pipe is empty', async () => {
      const io = pipedIo('');

      const code = await runSuperAdminCreate([...ARGS], io, resolveBootstrap);

      expect(code).toBe(EXIT.usage);
      expect(io.error.text).toBe('A password is required.\n');
      expect(run).not.toHaveBeenCalled();
    });

    /**
     * The bug this replaces: the prompt's promise never settled, so `main`
     * never resolved, nothing assigned `process.exitCode`, and Node exited
     * **0**. An operator who pressed Ctrl+C was told the account was created —
     * and on the ops path, which forces a TTY, that was the ordinary way to
     * back out.
     *
     * Both halves are asserted, because either alone is still wrong: a non-zero
     * exit with no explanation, or an explanation with a zero exit.
     *
     * A regression surfaces here as this test's own timeout rather than as an
     * assertion, since the failure mode is a promise that never settles;
     * `secret-input.spec.ts` races an explicit timer to make the same
     * regression legible at the layer that causes it.
     */
    it('exits with the usage code when the prompt is interrupted', async () => {
      const io = interruptedIo();

      const code = await runSuperAdminCreate([...ARGS], io, resolveBootstrap);

      expect(code).toBe(EXIT.usage);
      expect(code).not.toBe(EXIT.ok);
      expect(io.error.text).toBe('Cancelled; no account was created.\n');
      expect(run).not.toHaveBeenCalled();
      expect(resolveBootstrap).not.toHaveBeenCalled();
    });

    /** Cancelling is its own event, not "you gave me an empty password". */
    it('distinguishes a cancellation from an empty password', async () => {
      const cancelled = interruptedIo();
      await runSuperAdminCreate([...ARGS], cancelled, resolveBootstrap);

      const empty = pipedIo('');
      await runSuperAdminCreate([...ARGS], empty, resolveBootstrap);

      expect(cancelled.error.text).not.toBe(empty.error.text);
      expect(empty.error.text).toBe('A password is required.\n');
    });

    it('exits with the usage code when the confirmation does not match', async () => {
      const io = ttyIo('first-answer', 'second-answer');

      const code = await runSuperAdminCreate([...ARGS], io, resolveBootstrap);

      expect(code).toBe(EXIT.usage);
      expect(io.error.text).toBe('The passwords did not match.\n');
      expect(run).not.toHaveBeenCalled();
    });
  });

  /**
   * The bootstrap arrives as a thunk, and these assert the reason it does.
   *
   * Resolving it boots a Nest context, parses the whole authentication
   * configuration and opens a PostgreSQL connection. None of that can answer a
   * mistyped flag or a mismatched confirmation, and an operator repairing a
   * broken deployment has to be able to reach a usage message while the
   * database is exactly what is broken — so on every path that fails before a
   * usable password exists, the thunk must not be called at all.
   *
   * The spy is the only way to see this: eagerly resolving the bootstrap and
   * then discarding it produces identical output and an identical exit code,
   * and differs only in having connected.
   */
  describe('does not resolve the bootstrap on a usage error', () => {
    it.each([
      ['an unknown flag', ['--role', 'admin'] as string[], 'pw'],
      ['a malformed email', ['--email=nope', '--name=Ops'], 'pw'],
      ['a positional argument', ['create'], 'pw'],
      ['the --password flag', [...ARGS, '--password=hunter2'], 'pw'],
      ['an empty pipe', [...ARGS], ''],
    ])('given %s', async (_label, argv, password) => {
      const code = await runSuperAdminCreate(
        argv,
        pipedIo(password),
        resolveBootstrap,
      );

      expect(code).toBe(EXIT.usage);
      expect(resolveBootstrap).not.toHaveBeenCalled();
    });

    it('given a mismatched confirmation on a terminal', async () => {
      const code = await runSuperAdminCreate(
        [...ARGS],
        ttyIo('first-answer', 'second-answer'),
        resolveBootstrap,
      );

      expect(code).toBe(EXIT.usage);
      expect(resolveBootstrap).not.toHaveBeenCalled();
    });

    /** And exactly once when the input is good, so laziness is not never. */
    it('resolves it once when the arguments and the password are usable', async () => {
      const code = await runSuperAdminCreate(
        [...ARGS],
        pipedIo('pw'),
        resolveBootstrap,
      );

      expect(code).toBe(EXIT.ok);
      expect(resolveBootstrap).toHaveBeenCalledTimes(1);
    });
  });

  describe('the request it builds', () => {
    it('passes the parsed identity and the piped password through unchanged', async () => {
      await runSuperAdminCreate(
        ['--email=ops@example.com', '--name=Ops Team'],
        pipedIo(`${CANARY}\nignored`),
        resolveBootstrap,
      );

      expect(run).toHaveBeenCalledWith({
        email: 'ops@example.com',
        name: 'Ops Team',
        password: CANARY,
      });
    });

    /**
     * A piped caller's stdout is usually being captured by whatever invoked it,
     * so the conversational line is written only to a terminal.
     */
    it('announces itself on a terminal and stays quiet on a pipe', async () => {
      const terminal = ttyIo(CANARY, CANARY);
      await runSuperAdminCreate([...ARGS], terminal, resolveBootstrap);

      const pipe = pipedIo(CANARY);
      await runSuperAdminCreate([...ARGS], pipe, resolveBootstrap);

      expect(terminal.output.text).toContain(
        'Creating the first platform super administrator for ops@example.com.',
      );
      expect(pipe.output.text).not.toContain('Creating the first');
    });
  });

  /**
   * Each outcome maps to a distinct code, because an operator command is
   * scripted eventually and a script can only branch on the number. Collapsing
   * two of these into one would make "someone else is bootstrapping right now"
   * indistinguishable from "this platform already has an owner", which call for
   * opposite next steps.
   */
  describe('outcome to exit code', () => {
    it('reports a created administrator on stdout and exits 0', async () => {
      const io = pipedIo('pw');

      const code = await runSuperAdminCreate([...ARGS], io, resolveBootstrap);

      expect(code).toBe(EXIT.ok);
      expect(io.output.text).toContain(
        'Created super administrator ops@example.com (user-1).',
      );
      expect(io.error.text).toBe('');
    });

    it('exits 2 when the platform already has an administrator', async () => {
      run.mockResolvedValue({
        status: 'already-bootstrapped',
        existingCount: 2,
      });
      const io = pipedIo('pw');

      const code = await runSuperAdminCreate([...ARGS], io, resolveBootstrap);

      expect(code).toBe(EXIT.alreadyBootstrapped);
      expect(io.error.text).toContain(
        'This platform already has 2 super administrator(s).',
      );
      expect(io.output.text).toBe('');
    });

    it('exits 3 when another bootstrap holds the lock', async () => {
      run.mockResolvedValue({ status: 'locked' });
      const io = pipedIo('pw');

      const code = await runSuperAdminCreate([...ARGS], io, resolveBootstrap);

      expect(code).toBe(EXIT.locked);
      expect(io.error.text).toMatch(/Another bootstrap is already running/);
      expect(io.output.text).toBe('');
    });

    it('exits 4 when the email already belongs to an account', async () => {
      run.mockResolvedValue({ status: 'email-taken' });
      const io = pipedIo('pw');

      const code = await runSuperAdminCreate([...ARGS], io, resolveBootstrap);

      expect(code).toBe(EXIT.emailTaken);
      expect(io.error.text).toMatch(/already exists/);
      expect(io.output.text).toBe('');
    });

    /**
     * A usage error, not a failure: the operator gave an unusable argument and
     * the fix is to run it again with a different one. The bounds are named
     * because a refusal that does not say what would be accepted sends someone
     * guessing at the password for the account nobody can reset.
     */
    it('exits 1 naming the bounds when the password is out of range', async () => {
      run.mockResolvedValue({
        status: 'password-rejected',
        minLength: 8,
        maxLength: 128,
      });
      const io = pipedIo('short');

      const code = await runSuperAdminCreate([...ARGS], io, resolveBootstrap);

      expect(code).toBe(EXIT.usage);
      expect(io.error.text).toBe(
        'The password must be between 8 and 128 characters.\n',
      );
      expect(io.output.text).toBe('');
    });

    /** The reported bounds, not remembered ones. */
    it('reports whichever bounds the bootstrap returned', async () => {
      run.mockResolvedValue({
        status: 'password-rejected',
        minLength: 16,
        maxLength: 64,
      });
      const io = pipedIo('short');

      await runSuperAdminCreate([...ARGS], io, resolveBootstrap);

      expect(io.error.text).toContain('between 16 and 64 characters');
    });
  });

  describe('a thrown failure', () => {
    /**
     * The message and nothing else. A rejected Better Auth call carries the
     * request body on some paths, and that body holds the plaintext password,
     * so a stack — or a serialized cause, or the error object itself — printed
     * here would put the credential on the operator's terminal and into
     * whatever captured it.
     */
    it('exits 5 printing only the message, never a stack', async () => {
      const error = new Error('connect ECONNREFUSED 127.0.0.1:5432');
      run.mockRejectedValue(error);
      const io = pipedIo('pw');

      const code = await runSuperAdminCreate([...ARGS], io, resolveBootstrap);

      expect(code).toBe(EXIT.failed);
      expect(io.error.text).toBe(
        'Could not create the super administrator: connect ECONNREFUSED 127.0.0.1:5432\n',
      );
      expect(io.error.text).not.toMatch(/\bat .*\(/);
      expect(io.error.text).not.toContain('super-admin.command');
      expect(io.output.text).toBe('');
    });

    /** A rejection that is not an `Error` must still not be stringified. */
    it('exits 5 for a non-Error rejection without printing it', async () => {
      run.mockRejectedValue({ body: { password: CANARY } });
      const io = pipedIo('pw');

      const code = await runSuperAdminCreate([...ARGS], io, resolveBootstrap);

      expect(code).toBe(EXIT.failed);
      expect(io.error.text).toBe(
        'Could not create the super administrator: unknown error\n',
      );
    });

    /**
     * Resolving the bootstrap is itself fallible — an unreachable database, a
     * missing environment variable — and it happens after the password has been
     * read. It is inside the same guarded block for that reason: a Nest
     * dependency-injection failure escaping here would print a stack from a
     * frame that is holding the plaintext password.
     */
    it('exits 5 when the bootstrap cannot be resolved at all', async () => {
      resolveBootstrap.mockRejectedValueOnce(
        new Error('connect ECONNREFUSED 127.0.0.1:5432'),
      );
      const io = pipedIo('pw');

      const code = await runSuperAdminCreate([...ARGS], io, resolveBootstrap);

      expect(code).toBe(EXIT.failed);
      expect(io.error.text).toBe(
        'Could not create the super administrator: connect ECONNREFUSED 127.0.0.1:5432\n',
      );
      expect(run).not.toHaveBeenCalled();
    });
  });
});

/**
 * The property that outranks every other assertion in this file: whatever the
 * command does, the password does not appear in what it wrote.
 *
 * A leak here is silent and permanent. The operator's terminal scrollback, the
 * CI job log that ran the bootstrap, and any session recorder on the host all
 * keep whatever these two streams received, and the credential involved is the
 * one that owns the platform and cannot be rotated by anyone who does not
 * already hold it. So the password is a canary — a value that exists nowhere
 * else — and every path the command can take is driven with it and then
 * searched for it.
 */
describe('the password never reaches an output stream', () => {
  const run =
    jest.fn<(request: BootstrapRequest) => Promise<BootstrapOutcome>>();
  const bootstrap = { run };
  const resolveBootstrap = jest.fn(() => Promise.resolve(bootstrap));

  // The thunk is asserted on below, so its calls must not accumulate across
  // cases the way the outcome sweep's `run.mockReset()` handles for `run`.
  beforeEach(() => {
    resolveBootstrap.mockClear();
  });

  const outcomes: Array<[string, BootstrapOutcome]> = [
    [
      'created',
      { status: 'created', userId: 'user-1', email: 'ops@example.com' },
    ],
    [
      'already-bootstrapped',
      { status: 'already-bootstrapped', existingCount: 1 },
    ],
    ['locked', { status: 'locked' }],
    ['email-taken', { status: 'email-taken' }],
    [
      'password-rejected',
      { status: 'password-rejected', minLength: 8, maxLength: 128 },
    ],
  ];

  it.each(outcomes)('on the %s path', async (_label, outcome) => {
    run.mockReset().mockResolvedValue(outcome);
    const io = pipedIo(CANARY);

    await runSuperAdminCreate([...ARGS], io, resolveBootstrap);

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ password: CANARY }),
    );
    expect(io.output.text).not.toContain(CANARY);
    expect(io.error.text).not.toContain(CANARY);
  });

  it('on the interactive path, where the password is also typed', async () => {
    run.mockReset().mockResolvedValue(outcomes[0][1]);
    const io = ttyIo(CANARY, CANARY);

    await runSuperAdminCreate([...ARGS], io, resolveBootstrap);

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ password: CANARY }),
    );
    expect(io.output.text).not.toContain(CANARY);
    expect(io.error.text).not.toContain(CANARY);
  });

  /**
   * Interrupting mid-password is the one path where the secret exists only in
   * readline's buffer and is never used for anything. It must still not be
   * echoed on the way out — the operator typed it, the terminal is muted, and
   * the cancellation message is all that may appear.
   */
  it('when the prompt is interrupted after it was typed', async () => {
    const io = interruptedIo(CANARY);

    const code = await runSuperAdminCreate([...ARGS], io, resolveBootstrap);

    expect(code).toBe(EXIT.usage);
    expect(io.output.text).not.toContain(CANARY);
    expect(io.error.text).not.toContain(CANARY);
  });

  /**
   * The refusal of `--password` must not repeat the value back. An operator who
   * has just been told the flag is unsafe because it persists would otherwise
   * watch the command print it to the terminal in the same breath.
   */
  it('when refusing the --password flag that carried it', async () => {
    const io = pipedIo('unused');

    const code = await runSuperAdminCreate(
      [...ARGS, `--password=${CANARY}`],
      io,
      resolveBootstrap,
    );

    expect(code).toBe(EXIT.usage);
    expect(io.output.text).not.toContain(CANARY);
    expect(io.error.text).not.toContain(CANARY);
  });

  /**
   * The way a password most plausibly arrives as an argument: unquoted, in the
   * command position or trailing the flags, where the operator meant it as a
   * value and the shell handed it over as a positional. The refusal reports
   * where it was, never what it was — so this is the assertion that keeps
   * `Unexpected argument at position N` from regaining its value.
   */
  it.each([
    ['trailing the flags', [...ARGS, CANARY]],
    ['in the command position', [CANARY, ...ARGS]],
  ])('when refusing a stray positional %s', async (_label, argv) => {
    const io = pipedIo('unused');

    const code = await runSuperAdminCreate(argv, io, resolveBootstrap);

    expect(code).toBe(EXIT.usage);
    expect(io.output.text).not.toContain(CANARY);
    expect(io.error.text).not.toContain(CANARY);
    expect(resolveBootstrap).not.toHaveBeenCalled();
  });

  /**
   * The case the guard exists for. Better Auth validation errors quote the
   * offending request body, so the *message* of a thrown error can contain the
   * plaintext password even when no stack is printed. Printing the message
   * verbatim is therefore not sufficient: what leaves this command has to be
   * scrubbed of the secret it was given.
   */
  it('when the failure message itself quotes it', async () => {
    run
      .mockReset()
      .mockRejectedValue(
        new Error(
          `Invalid request body: {"email":"ops@example.com","password":"${CANARY}"}`,
        ),
      );
    const io = pipedIo(CANARY);

    const code = await runSuperAdminCreate([...ARGS], io, resolveBootstrap);

    expect(code).toBe(EXIT.failed);
    expect(io.output.text).not.toContain(CANARY);
    expect(io.error.text).not.toContain(CANARY);
  });
});
