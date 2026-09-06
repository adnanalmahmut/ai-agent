import { PassThrough, Readable, Writable } from 'node:stream';

import { describe, expect, it } from '@jest/globals';

import {
  REDACTED,
  isInteractive,
  promptHiddenSecret,
  readPassword,
  readPipedSecret,
  withoutSecret,
  type SecretIo,
} from '../../../src/cli/secret-input';

const TYPED = 'TYPED-S3cret-do-not-echo';

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

type PipedIo = SecretIo & { output: CaptureStream };

const piped = (...chunks: string[]): PipedIo => ({
  input: Readable.from(chunks.map((chunk) => Buffer.from(chunk, 'utf8'))),
  output: new CaptureStream(),
});

const tty = (...answers: string[]): PipedIo => {
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

  return { input, output };
};

const scriptedTty = (...actions: ((input: PassThrough) => void)[]): PipedIo => {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;

  const output = new CaptureStream();
  const pending = [...actions];

  output.onWrite = (text) => {
    if (!text.includes('assword: ')) return;

    const next = pending.shift();

    if (!next) return;

    setImmediate(() => {
      next(input);
    });
  };

  return { input, output };
};

const CTRL_C = '\u0003';
const CTRL_D = '\u0004';

const within = async <T>(work: Promise<T>, ms = 2_000): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;

  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`did not settle within ${ms}ms`)),
      ms,
    );
  });

  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
};

describe('withoutSecret', () => {
  it('replaces the secret with a visible marker', () => {
    expect(withoutSecret(`before ${TYPED} after`, TYPED)).toBe(
      `before ${REDACTED} after`,
    );
  });

  it('replaces every occurrence', () => {
    const text = `${TYPED} in the middle ${TYPED} and at the end ${TYPED}`;

    const scrubbed = withoutSecret(text, TYPED);

    expect(scrubbed).not.toContain(TYPED);
    expect(scrubbed.split(REDACTED)).toHaveLength(4);
  });

  it('leaves text that does not contain the secret exactly as it was', () => {
    const text = 'connect ECONNREFUSED 127.0.0.1:5432';

    expect(withoutSecret(text, TYPED)).toBe(text);
  });

  it('is a no-op for an empty secret', () => {
    const text = 'connect ECONNREFUSED 127.0.0.1:5432';

    expect(withoutSecret(text, '')).toBe(text);
  });

  describe('the JSON-escaped form', () => {
    const AWKWARD = 'P4ss"word\\with-both';
    const body = `Invalid body: ${JSON.stringify({ password: AWKWARD })}`;

    it('is removed from a serialized body', () => {
      expect(withoutSecret(body, AWKWARD)).toBe(
        `Invalid body: {"password":"${REDACTED}"}`,
      );
    });

    it('is the only form present, so a raw-only scrub would leak it', () => {
      expect(body).not.toContain(AWKWARD);
      expect(body.split(AWKWARD).join(REDACTED)).toContain('P4ss');
    });

    it('is removed alongside a raw occurrence', () => {
      const scrubbed = withoutSecret(`${AWKWARD} :: ${body}`, AWKWARD);

      expect(scrubbed).toBe(
        `${REDACTED} :: Invalid body: {"password":"${REDACTED}"}`,
      );
    });
  });
});

describe('isInteractive', () => {
  it('treats a piped stdin as non-interactive', () => {
    expect(isInteractive(piped('x'))).toBe(false);
  });

  it('treats a TTY stdin as interactive', () => {
    expect(isInteractive(tty())).toBe(true);
  });
});

describe('readPipedSecret', () => {
  it('takes only the first line', async () => {
    await expect(readPipedSecret(piped('pw\nrest'))).resolves.toBe('pw');
  });

  it('drops a single trailing newline', async () => {
    await expect(readPipedSecret(piped(`${TYPED}\n`))).resolves.toBe(TYPED);
  });

  it('drops a trailing carriage return and newline', async () => {
    await expect(readPipedSecret(piped(`${TYPED}\r\n`))).resolves.toBe(TYPED);
  });

  it('joins chunks before finding the first line break', async () => {
    await expect(
      readPipedSecret(piped('TYPED-', 'S3cret\nrest')),
    ).resolves.toBe('TYPED-S3cret');
  });

  it('reports an empty string for an empty pipe', async () => {
    await expect(readPipedSecret(piped())).resolves.toBe('');
  });
});

describe('promptHiddenSecret', () => {
  it('writes the prompt and never echoes what was typed', async () => {
    const io = tty(TYPED);

    await expect(promptHiddenSecret(io, 'Password: ')).resolves.toBe(TYPED);

    expect(io.output.text).toContain('Password: ');
    expect(io.output.text).not.toContain(TYPED);
    expect(io.output.text).not.toContain('TYPED');
  });

  it('ends the prompt line so later output starts on its own line', async () => {
    const io = tty(TYPED);

    await promptHiddenSecret(io, 'Password: ');

    expect(io.output.text.endsWith('\n')).toBe(true);
  });

  it('restores output after the prompt is finished', async () => {
    const io = tty(TYPED, 'second');

    await promptHiddenSecret(io, 'Password: ');
    await promptHiddenSecret(io, 'Confirm password: ');

    expect(io.output.text).toContain('Confirm password: ');
    expect(io.output.text).not.toContain('second');
  });
});

describe('an interrupted prompt', () => {
  it.each([
    ['Ctrl+C', CTRL_C],
    ['Ctrl+D', CTRL_D],
  ])(
    'resolves undefined on %s rather than never settling',
    async (_label, key) => {
      const io = scriptedTty((input) => input.write(key));

      await expect(
        within(promptHiddenSecret(io, 'Password: ')),
      ).resolves.toBeUndefined();
    },
  );

  it('resolves undefined when the input stream ends', async () => {
    const io = scriptedTty((input) => input.end());

    await expect(
      within(promptHiddenSecret(io, 'Password: ')),
    ).resolves.toBeUndefined();
  });

  it('does not echo what was typed before the interruption', async () => {
    const io = scriptedTty((input) => {
      input.write(TYPED);
      input.write(CTRL_C);
    });

    await within(promptHiddenSecret(io, 'Password: '));

    expect(io.output.text).not.toContain(TYPED);
  });

  it.each([
    ['Ctrl+C', CTRL_C],
    ['Ctrl+D', CTRL_D],
  ])('reports %s at the first prompt as cancelled', async (_label, key) => {
    const io = scriptedTty((input) => input.write(key));

    await expect(within(readPassword(io))).resolves.toEqual({
      ok: false,
      reason: 'cancelled',
    });
  });

  it('reports an interruption at the confirmation as cancelled', async () => {
    const io = scriptedTty(
      (input) => input.write(`${TYPED}\n`),
      (input) => input.write(CTRL_C),
    );

    await expect(within(readPassword(io))).resolves.toEqual({
      ok: false,
      reason: 'cancelled',
    });
  });

  it('is not reported as an empty password', async () => {
    const io = scriptedTty((input) => input.write(CTRL_C));

    const result = await within(readPassword(io));

    expect(result).not.toEqual({ ok: false, reason: 'empty' });
  });
});

describe('readPassword', () => {
  it('uses the first line of stdin when the caller is piping', async () => {
    await expect(readPassword(piped(`${TYPED}\nignored`))).resolves.toEqual({
      ok: true,
      password: TYPED,
    });
  });

  it('reports an empty pipe rather than accepting an empty password', async () => {
    await expect(readPassword(piped())).resolves.toEqual({
      ok: false,
      reason: 'empty',
    });
  });

  it('asks a terminal twice and accepts two matching answers', async () => {
    const io = tty(TYPED, TYPED);

    await expect(readPassword(io)).resolves.toEqual({
      ok: true,
      password: TYPED,
    });

    expect(io.output.text).toContain('Password: ');
    expect(io.output.text).toContain('Confirm password: ');
    expect(io.output.text).not.toContain(TYPED);
  });

  it('reports a mismatch when the confirmation differs', async () => {
    const io = tty(TYPED, `${TYPED}-typo`);

    await expect(readPassword(io)).resolves.toEqual({
      ok: false,
      reason: 'mismatch',
    });

    expect(io.output.text).not.toContain(TYPED);
  });

  it('reports an empty terminal answer without asking to confirm', async () => {
    const io = tty('', TYPED);

    await expect(readPassword(io)).resolves.toEqual({
      ok: false,
      reason: 'empty',
    });

    expect(io.output.text).not.toContain('Confirm password: ');
  });
});
