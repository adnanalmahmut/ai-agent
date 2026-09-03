import { PassThrough, Readable, Writable } from 'node:stream';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type {
  BootstrapOutcome,
  BootstrapRequest,
} from '../../../src/cli/super-admin.bootstrap';
import {
  EXIT,
  USAGE,
  parseArgs,
  runSuperAdminCreate,
  type CommandIo,
} from '../../../src/cli/super-admin.command';

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

const pipedIo = (password: string): TestIo => ({
  input: Readable.from([Buffer.from(password, 'utf8')]),
  output: new CaptureStream(),
  error: new CaptureStream(),
});

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

const CTRL_C = '\u0003';

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

  it('accepts the inline --flag=value form', () => {
    expect(parseArgs(['--email=ops@example.com', '--name=Ops Team'])).toEqual({
      ok: true,
      email: 'ops@example.com',
      name: 'Ops Team',
    });
  });

  it('keeps everything after the first = as the value', () => {
    expect(parseArgs(['--email=ops@example.com', '--name=A=B'])).toEqual({
      ok: true,
      email: 'ops@example.com',
      name: 'A=B',
    });
  });

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

  it('refuses a missing name with the same message as an empty one', () => {
    expect(parseArgs(['--email', 'ops@example.com'])).toEqual({
      ok: false,
      message: 'A non-empty --name is required',
    });
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
  ])('refuses a %s name', (_label, name) => {
    expect(parseArgs(['--email', 'ops@example.com', '--name', name])).toEqual({
      ok: false,
      message: 'A non-empty --name is required',
    });
  });

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

  it('does not change the case of the name', () => {
    expect(parseArgs(['--email=ops@example.com', '--name=Ops McOps'])).toEqual({
      ok: true,
      email: 'ops@example.com',
      name: 'Ops McOps',
    });
  });

  it.each([
    ['--email', ['--email', 'a@example.com', '--email', 'b@example.com']],
    ['--name', ['--name', 'First', '--name', 'Second']],
  ])('refuses a repeated %s', (flag, argv) => {
    expect(parseArgs(argv)).toEqual({
      ok: false,
      message: `Repeated option: ${flag}`,
    });
  });

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

  it('refuses an unknown flag', () => {
    expect(parseArgs([...ARGS, '--role', 'admin'])).toEqual({
      ok: false,
      message: 'Unknown option: --role',
    });
  });

  it('refuses a positional argument without repeating it', () => {
    expect(parseArgs(['create', ...ARGS])).toEqual({
      ok: false,
      message: 'Unexpected argument at position 1',
    });
  });

  it('reports the position of a trailing positional', () => {
    expect(parseArgs([...ARGS, 'stray'])).toEqual({
      ok: false,
      message: 'Unexpected argument at position 5',
    });
  });

  it.each([
    ['as a separate token', ['--password', 'hunter2']],
    ['in the inline form', ['--password=hunter2']],
  ])('refuses --password %s', (_label, passwordArgs) => {
    const result = parseArgs([...ARGS, ...passwordArgs]);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toMatch(/shell history/i);
  });

  it('refuses --password before reporting anything else wrong', () => {
    const result = parseArgs(['--password', 'hunter2']);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toMatch(/shell history/i);
    expect(result.ok ? '' : result.message).not.toMatch(/--email/);
  });

  it('refuses --password even alongside a valid identity', () => {
    const result = parseArgs([
      '--email=ops@example.com',
      '--name=Ops',
      '--password=x',
    ]);

    expect(result.ok).toBe(false);
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
      expect(run).not.toHaveBeenCalled();
    });

    it('exits with the usage code when the pipe is empty', async () => {
      const io = pipedIo('');

      const code = await runSuperAdminCreate([...ARGS], io, resolveBootstrap);

      expect(code).toBe(EXIT.usage);
      expect(io.error.text).toBe('A password is required.\n');
      expect(run).not.toHaveBeenCalled();
    });

    it('exits with the usage code when the prompt is interrupted', async () => {
      const io = interruptedIo();

      const code = await runSuperAdminCreate([...ARGS], io, resolveBootstrap);

      expect(code).toBe(EXIT.usage);
      expect(code).not.toBe(EXIT.ok);
      expect(io.error.text).toBe('Cancelled; no account was created.\n');
      expect(run).not.toHaveBeenCalled();
      expect(resolveBootstrap).not.toHaveBeenCalled();
    });

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

    it('exits 5 for a non-Error rejection without printing it', async () => {
      run.mockRejectedValue({ body: { password: CANARY } });
      const io = pipedIo('pw');

      const code = await runSuperAdminCreate([...ARGS], io, resolveBootstrap);

      expect(code).toBe(EXIT.failed);
      expect(io.error.text).toBe(
        'Could not create the super administrator: unknown error\n',
      );
    });

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

describe('the password never reaches an output stream', () => {
  const run =
    jest.fn<(request: BootstrapRequest) => Promise<BootstrapOutcome>>();
  const bootstrap = { run };
  const resolveBootstrap = jest.fn(() => Promise.resolve(bootstrap));

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

  it('when the prompt is interrupted after it was typed', async () => {
    const io = interruptedIo(CANARY);

    const code = await runSuperAdminCreate([...ARGS], io, resolveBootstrap);

    expect(code).toBe(EXIT.usage);
    expect(io.output.text).not.toContain(CANARY);
    expect(io.error.text).not.toContain(CANARY);
  });

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
