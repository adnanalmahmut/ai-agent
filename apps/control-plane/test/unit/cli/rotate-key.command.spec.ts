import { Readable, Writable } from 'node:stream';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type {
  RotationOptions,
  RotationReport,
} from '../../../src/features/control-plane/managed-secrets/managed-secret-rotation.service';
import {
  ROTATE_EXIT,
  parseRotateArgs,
  runRotateKey,
} from '../../../src/cli/rotate-key.command';
import type { CommandIo } from '../../../src/cli/super-admin.command';

class CaptureStream extends Writable {
  private readonly parts: string[] = [];

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.parts.push(
      Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk),
    );
    callback();
  }

  get text(): string {
    return this.parts.join('');
  }
}

type TestIo = CommandIo & { output: CaptureStream; error: CaptureStream };

const io = (): TestIo => ({
  input: Readable.from([]),
  output: new CaptureStream(),
  error: new CaptureStream(),
});

const report = (over: Partial<RotationReport> = {}): RotationReport => ({
  examined: 0,
  rotated: 0,
  alreadyActive: 0,
  wouldRotate: 0,
  unreadable: 0,
  concurrentlyModified: 0,
  unknownSlot: 0,
  outcomes: [],
  ...over,
});

describe('parseRotateArgs', () => {
  it('defaults to a live run with the service default batch size', () => {
    expect(parseRotateArgs([])).toEqual({
      ok: true,
      batchSize: undefined,
      dryRun: false,
    });
  });

  it('accepts a batch size and the dry-run flag in either order', () => {
    expect(parseRotateArgs(['--dry-run', '--batch-size', '10'])).toEqual({
      ok: true,
      batchSize: 10,
      dryRun: true,
    });
  });

  it.each(['1e3', '0x10', ' 12', '12.5', '-1', ''])(
    'refuses the non-integer batch size %p',
    (value) => {
      const parsed = parseRotateArgs(['--batch-size', value]);

      expect(parsed.ok).toBe(false);
    },
  );

  it('refuses a batch size outside the supported range', () => {
    expect(parseRotateArgs(['--batch-size', '0'])).toMatchObject({ ok: false });
    expect(parseRotateArgs(['--batch-size', '100000'])).toMatchObject({
      ok: false,
    });
  });

  it('refuses --batch-size with no value', () => {
    expect(parseRotateArgs(['--batch-size'])).toMatchObject({ ok: false });
    expect(parseRotateArgs(['--batch-size', '--dry-run'])).toMatchObject({
      ok: false,
    });
  });

  it('refuses an unknown argument rather than ignoring it', () => {
    expect(parseRotateArgs(['--force'])).toMatchObject({ ok: false });
    expect(parseRotateArgs(['openai.api_key'])).toMatchObject({ ok: false });
  });
});

describe('runRotateKey', () => {
  const rotateAll =
    jest.fn<(options?: RotationOptions) => Promise<RotationReport>>();
  const resolve = jest.fn(() => Promise.resolve({ rotateAll }));

  beforeEach(() => {
    rotateAll.mockReset().mockResolvedValue(report());
    resolve.mockClear();
  });

  it('refuses bad arguments before building anything', async () => {
    const streams = io();

    const code = await runRotateKey(['--nope'], streams, resolve);

    expect(code).toBe(ROTATE_EXIT.usage);
    expect(resolve).not.toHaveBeenCalled();
    expect(streams.error.text).toContain('Unexpected argument: --nope');
  });

  it('exits 0 and says so when everything is already current', async () => {
    rotateAll.mockResolvedValue(report({ examined: 1, alreadyActive: 1 }));
    const streams = io();

    const code = await runRotateKey([], streams, resolve);

    expect(code).toBe(ROTATE_EXIT.ok);
    expect(streams.output.text).toContain('1 already current');
    expect(streams.error.text).toBe('');
  });

  it('exits 0 after rotating', async () => {
    rotateAll.mockResolvedValue(
      report({
        examined: 2,
        rotated: 1,
        alreadyActive: 1,
        outcomes: [
          {
            key: 'openai.api_key',
            disposition: 'rotated',
            fromKeyVersion: 'v1',
          },
        ],
      }),
    );
    const streams = io();

    expect(await runRotateKey([], streams, resolve)).toBe(ROTATE_EXIT.ok);
    expect(streams.output.text).toContain('1 rotated');
  });

  it.each([
    ['an unreadable row', report({ examined: 1, unreadable: 1 })],
    [
      'a row that changed mid-run',
      report({ examined: 1, concurrentlyModified: 1 }),
    ],
    ['a row for an unknown slot', report({ examined: 1, unknownSlot: 1 })],
  ])('exits non-zero for %s', async (_label, incomplete) => {
    rotateAll.mockResolvedValue(incomplete);

    expect(await runRotateKey([], io(), resolve)).toBe(ROTATE_EXIT.incomplete);
  });

  it('names the rows that need attention and what to do', async () => {
    rotateAll.mockResolvedValue(
      report({
        examined: 1,
        unreadable: 1,
        outcomes: [
          {
            key: 'openai.api_key',
            disposition: 'unreadable',
            fromKeyVersion: 'v0',
          },
        ],
      }),
    );
    const streams = io();

    await runRotateKey([], streams, resolve);

    expect(streams.output.text).toContain('Needs attention:');
    expect(streams.output.text).toContain('openai.api_key');
    expect(streams.output.text).toContain('Re-enter that credential');
  });

  it('passes the parsed options through and reports a dry run as one', async () => {
    rotateAll.mockResolvedValue(report({ examined: 1, wouldRotate: 1 }));
    const streams = io();

    await runRotateKey(['--dry-run', '--batch-size', '7'], streams, resolve);

    expect(rotateAll).toHaveBeenCalledWith({ batchSize: 7, dryRun: true });
    expect(streams.output.text).toContain('wrote nothing');
    expect(streams.output.text).toContain('1 would rotate');
  });

  it('exits non-zero on a dry run that still has rows to rotate', async () => {
    rotateAll.mockResolvedValue(report({ examined: 1, wouldRotate: 1 }));

    expect(await runRotateKey(['--dry-run'], io(), resolve)).toBe(
      ROTATE_EXIT.incomplete,
    );
  });

  it('exits 0 on a dry run over an already-current table', async () => {
    rotateAll.mockResolvedValue(report({ examined: 2, alreadyActive: 2 }));

    expect(await runRotateKey(['--dry-run'], io(), resolve)).toBe(
      ROTATE_EXIT.ok,
    );
  });

  it.each([
    ['a dry run', ['--dry-run']],
    ['a live run', []],
  ])(
    'refuses to exit 0 when %s examined nothing at all',
    async (_label, argv) => {
      rotateAll.mockResolvedValue(report({ examined: 0 }));
      const streams = io();

      expect(await runRotateKey(argv, streams, resolve)).toBe(
        ROTATE_EXIT.incomplete,
      );
      expect(streams.error.text).toContain('Examined no secrets');
    },
  );

  it('exits 0 on a live run that rotated everything it found', async () => {
    rotateAll.mockResolvedValue(report({ examined: 3, rotated: 3 }));

    expect(await runRotateKey([], io(), resolve)).toBe(ROTATE_EXIT.ok);
  });

  it('reports a thrown failure without a stack and exits distinctly', async () => {
    rotateAll.mockRejectedValue(new Error('connection terminated'));
    const streams = io();

    const code = await runRotateKey([], streams, resolve);

    expect(code).toBe(ROTATE_EXIT.failed);
    expect(streams.error.text).toBe('Rotation failed: connection terminated\n');
    expect(streams.error.text).not.toContain('at ');
  });

  it('never writes a credential to either stream', async () => {
    const canary = 'sk-CANARY-cli-do-not-log-000000000';
    rotateAll.mockResolvedValue(
      report({
        examined: 1,
        unreadable: 1,
        outcomes: [
          {
            key: 'openai.api_key',
            disposition: 'unreadable',
            fromKeyVersion: 'v1',
          },
        ],
      }),
    );
    const streams = io();

    await runRotateKey([], streams, resolve);

    expect(streams.output.text).not.toContain(canary);
    expect(streams.output.text).not.toContain('CANARY');
    expect(streams.error.text).not.toContain('CANARY');
  });
});
