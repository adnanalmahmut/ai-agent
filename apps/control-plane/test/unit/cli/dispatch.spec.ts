import { Readable, Writable } from 'node:stream';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type {
  RotationOptions,
  RotationReport,
} from '../../../src/features/control-plane/managed-secrets/managed-secret-rotation.service';
import { CLI_USAGE, dispatchCliCommand } from '../../../src/cli/dispatch';
import { ROTATE_USAGE } from '../../../src/cli/rotate-key.command';
import type {
  BootstrapOutcome,
  BootstrapRequest,
} from '../../../src/cli/super-admin.bootstrap';
import {
  EXIT,
  USAGE,
  type CommandIo,
} from '../../../src/cli/super-admin.command';

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

const pipedIo = (password = 'piped-password'): TestIo => ({
  input: Readable.from([Buffer.from(password, 'utf8')]),
  output: new CaptureStream(),
  error: new CaptureStream(),
});

describe('dispatchCliCommand', () => {
  const run =
    jest.fn<(request: BootstrapRequest) => Promise<BootstrapOutcome>>();
  const resolveBootstrap = jest.fn(() => Promise.resolve({ run }));
  const rotateAll =
    jest.fn<(options?: RotationOptions) => Promise<RotationReport>>();
  const resolveRotation = jest.fn(() => Promise.resolve({ rotateAll }));
  const deps = { bootstrap: resolveBootstrap, rotation: resolveRotation };

  beforeEach(() => {
    run.mockReset().mockResolvedValue({
      status: 'created',
      userId: 'user-1',
      email: 'ops@example.com',
    });
    rotateAll.mockReset().mockResolvedValue({
      examined: 1,
      rotated: 0,
      alreadyActive: 1,
      wouldRotate: 0,
      unreadable: 0,
      concurrentlyModified: 0,
      unknownSlot: 0,
      outcomes: [],
    });
    resolveBootstrap.mockClear();
    resolveRotation.mockClear();
  });

  describe.each([['--help'], ['-h']])('given %s', (flag) => {
    it('writes the usage text to stdout and exits 0', async () => {
      const io = pipedIo();

      const code = await dispatchCliCommand([flag], io, deps);

      expect(code).toBe(EXIT.ok);
      expect(io.output.text).toBe(CLI_USAGE);
      expect(io.error.text).toBe('');
    });

    it('writes the command usage when the flag follows a command', async () => {
      const io = pipedIo();

      const code = await dispatchCliCommand(
        ['super-admin:create', flag],
        io,
        deps,
      );

      expect(code).toBe(EXIT.ok);
      expect(io.output.text).toBe(USAGE);
      expect(resolveBootstrap).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    });

    it('writes the rotation usage when the flag follows that command', async () => {
      const io = pipedIo();

      const code = await dispatchCliCommand(
        ['managed-secret:rotate-key', flag],
        io,
        deps,
      );

      expect(code).toBe(EXIT.ok);
      expect(io.output.text).toBe(ROTATE_USAGE);
      expect(resolveRotation).not.toHaveBeenCalled();
      expect(rotateAll).not.toHaveBeenCalled();
    });
  });

  describe('given managed-secret:rotate-key', () => {
    it('forwards the remaining arguments to the rotation command', async () => {
      const io = pipedIo();

      const code = await dispatchCliCommand(
        ['managed-secret:rotate-key', '--dry-run', '--batch-size', '5'],
        io,
        deps,
      );

      expect(code).toBe(EXIT.ok);
      expect(rotateAll).toHaveBeenCalledWith({ batchSize: 5, dryRun: true });
    });

    it('lets the rotation command refuse its own arguments', async () => {
      const io = pipedIo();

      const code = await dispatchCliCommand(
        ['managed-secret:rotate-key', '--nope'],
        io,
        deps,
      );

      expect(code).toBe(EXIT.usage);
      expect(io.error.text).toContain('Unexpected argument: --nope');
      expect(resolveRotation).not.toHaveBeenCalled();
    });
  });

  it('given no command, writes usage but exits with the usage code', async () => {
    const io = pipedIo();

    const code = await dispatchCliCommand([], io, deps);

    expect(code).toBe(EXIT.usage);
    expect(io.output.text).toBe(CLI_USAGE);
    expect(io.error.text).toBe('');
  });

  describe('given an unknown command', () => {
    it('names it on stderr and exits with the usage code', async () => {
      const io = pipedIo();

      const code = await dispatchCliCommand(['super-admin:crate'], io, deps);

      expect(code).toBe(EXIT.usage);
      expect(io.error.text).toBe(
        `Unknown command: super-admin:crate\n\n${CLI_USAGE}`,
      );
      expect(io.output.text).toBe('');
    });

    it('rejects a command that merely starts with the real one', async () => {
      const io = pipedIo();

      const code = await dispatchCliCommand(
        ['super-admin:create-owner'],
        io,
        deps,
      );

      expect(code).toBe(EXIT.usage);
      expect(io.error.text).toContain(
        'Unknown command: super-admin:create-owner',
      );
    });

    it('rejects a leading flag it does not know', async () => {
      const io = pipedIo();

      const code = await dispatchCliCommand(
        ['--email=ops@example.com'],
        io,
        deps,
      );

      expect(code).toBe(EXIT.usage);
      expect(io.error.text).toContain(
        'Unknown command: --email=ops@example.com',
      );
    });
  });

  describe('given super-admin:create', () => {
    it('forwards the remaining arguments to the create command', async () => {
      const io = pipedIo('piped-password');

      const code = await dispatchCliCommand(
        ['super-admin:create', '--email=ops@example.com', '--name=Ops Team'],
        io,
        deps,
      );

      expect(code).toBe(EXIT.ok);
      expect(run).toHaveBeenCalledWith({
        email: 'ops@example.com',
        name: 'Ops Team',
        password: 'piped-password',
      });
      expect(io.output.text).toContain('Created super administrator');
    });

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
        deps,
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
        deps,
      );

      expect(code).toBe(EXIT.locked);
    });
  });

  it.each([
    ['--help', ['--help']],
    ['-h', ['-h']],
    ['no command', [] as string[]],
    ['an unknown command', ['nonsense']],
  ])('does not resolve the bootstrap for %s', async (_label, argv) => {
    await dispatchCliCommand(argv, pipedIo(), deps);

    expect(resolveBootstrap).not.toHaveBeenCalled();
  });
});
