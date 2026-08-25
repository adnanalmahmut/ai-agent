import { Readable, Writable } from 'node:stream';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { dispatchCliCommand } from '../dispatch';
import type {
  BootstrapOutcome,
  BootstrapRequest,
} from '../super-admin.bootstrap';
import { EXIT, USAGE, type CommandIo } from '../super-admin.command';

/**
 * Which command ran, and what the process exits with.
 *
 * This is the layer that used to live inside `cli.ts`, where nothing could
 * reach it: a module that runs on import can only be tested by a copy of
 * itself, and a copy keeps passing after the original changes. The failures it
 * hides are all quiet ones — `--help` exiting non-zero and breaking a
 * provisioning script, an unknown command exiting zero and looking like a
 * successful bootstrap, a usage path that opens a database connection on a host
 * where the database is exactly what is broken.
 *
 * `runSuperAdminCreate` is deliberately not mocked. What is being asserted
 * about the delegating branch is that the *remaining* arguments are what get
 * parsed, and the only honest evidence for that is the real parser acting on
 * them: were the command name forwarded too, it would be an unexpected
 * positional and the run would never happen.
 */

class CaptureStream extends Writable {
  private readonly parts: string[] = [];

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.parts.push(
      Buffer.isBuffer(chunk)
        ? chunk.toString('utf8')
        : typeof chunk === 'string'
          ? chunk
          : '',
    );
    callback();
  }

  get text(): string {
    return this.parts.join('');
  }
}

type TestIo = CommandIo & { output: CaptureStream; error: CaptureStream };

/** Stdin as a pipe, so no path here waits on a terminal that will never type. */
const pipedIo = (password = 'piped-password'): TestIo => ({
  input: Readable.from([Buffer.from(password, 'utf8')]),
  output: new CaptureStream(),
  error: new CaptureStream(),
});

describe('dispatchCliCommand', () => {
  const run =
    jest.fn<(request: BootstrapRequest) => Promise<BootstrapOutcome>>();
  const resolveBootstrap = jest.fn(() => Promise.resolve({ run }));

  beforeEach(() => {
    run.mockReset().mockResolvedValue({
      status: 'created',
      userId: 'user-1',
      email: 'ops@example.com',
    });
    resolveBootstrap.mockClear();
  });

  /**
   * Usage is an answer here, not an error, so it goes to stdout and the command
   * succeeds. An operator piping `--help` into a pager, or a script capturing
   * it, gets the text where they asked for it.
   */
  describe.each([['--help'], ['-h']])('given %s', (flag) => {
    it('writes the usage text to stdout and exits 0', async () => {
      const io = pipedIo();

      const code = await dispatchCliCommand([flag], io, resolveBootstrap);

      expect(code).toBe(EXIT.ok);
      expect(io.output.text).toBe(USAGE);
      expect(io.error.text).toBe('');
    });
  });

  /**
   * The asymmetry is deliberate and is pinned for that reason: the same text is
   * printed, and the exit code is the only thing that distinguishes "I asked
   * for help and got it" from "I was invoked with nothing at all". A script
   * that lost its arguments has no other way to notice, and a bootstrap that
   * silently did nothing while reporting success is the worst way for this
   * particular command to fail.
   */
  it('given no command, writes usage but exits with the usage code', async () => {
    const io = pipedIo();

    const code = await dispatchCliCommand([], io, resolveBootstrap);

    expect(code).toBe(EXIT.usage);
    expect(io.output.text).toBe(USAGE);
    expect(io.error.text).toBe('');
  });

  /**
   * An unrecognized command is a failure, so it is reported on stderr and names
   * what was not understood — an operator who typed `super-admin:crate` needs
   * to see their own typo, not just the usage block.
   */
  describe('given an unknown command', () => {
    it('names it on stderr and exits with the usage code', async () => {
      const io = pipedIo();

      const code = await dispatchCliCommand(
        ['super-admin:crate'],
        io,
        resolveBootstrap,
      );

      expect(code).toBe(EXIT.usage);
      expect(io.error.text).toBe(
        `Unknown command: super-admin:crate\n\n${USAGE}`,
      );
      expect(io.output.text).toBe('');
    });

    /** Matched whole, not by prefix: a longer name is a different command. */
    it('rejects a command that merely starts with the real one', async () => {
      const io = pipedIo();

      const code = await dispatchCliCommand(
        ['super-admin:create-owner'],
        io,
        resolveBootstrap,
      );

      expect(code).toBe(EXIT.usage);
      expect(io.error.text).toContain(
        'Unknown command: super-admin:create-owner',
      );
    });

    /** A stray flag in the command position is a command, not a flag. */
    it('rejects a leading flag it does not know', async () => {
      const io = pipedIo();

      const code = await dispatchCliCommand(
        ['--email=ops@example.com'],
        io,
        resolveBootstrap,
      );

      expect(code).toBe(EXIT.usage);
      expect(io.error.text).toContain(
        'Unknown command: --email=ops@example.com',
      );
    });
  });

  describe('given super-admin:create', () => {
    /**
     * The command name must not survive into the argument list. If it did, the
     * parser would see an unexpected positional and refuse every invocation —
     * so the successful run *is* the assertion that only the rest was
     * forwarded.
     */
    it('forwards the remaining arguments to the create command', async () => {
      const io = pipedIo('piped-password');

      const code = await dispatchCliCommand(
        ['super-admin:create', '--email=ops@example.com', '--name=Ops Team'],
        io,
        resolveBootstrap,
      );

      expect(code).toBe(EXIT.ok);
      expect(run).toHaveBeenCalledWith({
        email: 'ops@example.com',
        name: 'Ops Team',
        password: 'piped-password',
      });
      expect(io.output.text).toContain('Created super administrator');
    });

    /** And the rest really is parsed, rather than dispatch answering for it. */
    it('lets the create command refuse its own arguments', async () => {
      const io = pipedIo();

      const code = await dispatchCliCommand(
        [
          'super-admin:create',
          '--email=ops@example.com',
          '--name=Ops',
          '--role=admin',
        ],
        io,
        resolveBootstrap,
      );

      expect(code).toBe(EXIT.usage);
      expect(io.error.text).toContain('Unknown option: --role');
      expect(run).not.toHaveBeenCalled();
    });

    it('returns the exit code the create command chose, unchanged', async () => {
      run.mockResolvedValue({ status: 'locked' });
      const io = pipedIo();

      const code = await dispatchCliCommand(
        ['super-admin:create', '--email=ops@example.com', '--name=Ops'],
        io,
        resolveBootstrap,
      );

      expect(code).toBe(EXIT.locked);
    });
  });

  /**
   * Resolving the bootstrap boots a Nest context and connects to PostgreSQL.
   * None of these branches needs it, and the one place this command has to work
   * unconditionally is a host where the deployment is broken — so a usage
   * message must never depend on a reachable database.
   */
  it.each([
    ['--help', ['--help']],
    ['-h', ['-h']],
    ['no command', [] as string[]],
    ['an unknown command', ['nonsense']],
  ])('does not resolve the bootstrap for %s', async (_label, argv) => {
    await dispatchCliCommand(argv, pipedIo(), resolveBootstrap);

    expect(resolveBootstrap).not.toHaveBeenCalled();
  });
});
