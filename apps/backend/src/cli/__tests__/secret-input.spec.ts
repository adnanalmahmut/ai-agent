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
} from '../secret-input';

/**
 * The two ways a password may reach this process, and the one thing neither of
 * them may do with it.
 *
 * Every assertion here is about a failure that is invisible when it happens.
 * A trailing newline folded into the secret produces an account whose password
 * is not the one the operator typed, and nothing says so until a sign-in fails
 * weeks later. An echo that is not suppressed puts the platform-owning
 * credential on a screen, into a terminal scrollback, and into whatever session
 * recorder the host runs — and the command still reports success.
 *
 * The streams are real `node:stream` objects rather than mocks, because the
 * behaviour under test is readline's interaction with an output stream, and a
 * fake output would be asserting against this file's own idea of readline.
 */

/** A secret distinctive enough that a single occurrence anywhere is provable. */
const TYPED = 'TYPED-S3cret-do-not-echo';

/** Records everything written, and lets a test react to a prompt appearing. */
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

/** Stdin as a pipe: no `isTTY`, exactly what a shell redirection produces. */
const piped = (...chunks: string[]): PipedIo => ({
  input: Readable.from(chunks.map((chunk) => Buffer.from(chunk, 'utf8'))),
  output: new CaptureStream(),
});

/**
 * Stdin as a terminal, answering each prompt as it appears.
 *
 * The answers are written in reaction to the prompt reaching the output stream
 * rather than after a timer, so the test is deterministic: nothing is typed
 * before the reader is listening, and a prompt that is never written hangs the
 * test rather than passing it by accident.
 */
const tty = (...answers: string[]): PipedIo => {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;

  const output = new CaptureStream();
  const pending = [...answers];

  output.onWrite = (text) => {
    if (!text.includes('assword: ')) return;

    const next = pending.shift();

    if (next === undefined) return;

    // Deferred, so the answer is never delivered inside readline's own write.
    setImmediate(() => input.write(`${next}\n`));
  };

  return { input, output };
};

/**
 * Stdin as a terminal driven one prompt at a time.
 *
 * Each action runs once its own prompt has been written, which is the only
 * moment at which typing — or interrupting — is meaningful: before it, readline
 * is not listening, and a test that raced the prompt would be asserting its own
 * timing rather than the code's behaviour.
 */
const scriptedTty = (...actions: ((input: PassThrough) => void)[]): PipedIo => {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;

  const output = new CaptureStream();
  const pending = [...actions];

  output.onWrite = (text) => {
    if (!text.includes('assword: ')) return;

    const next = pending.shift();

    if (!next) return;

    // Deferred, so nothing is delivered inside readline's own write.
    setImmediate(() => {
      next(input);
    });
  };

  return { input, output };
};

/** Ctrl+C. Raw mode has disabled ISIG, so readline sees the key, not a signal. */
const CTRL_C = '\u0003';
/** Ctrl+D on an empty line: end of input. */
const CTRL_D = '\u0004';

/**
 * Fails instead of hanging.
 *
 * The regression this whole group guards is a promise that never settles, and
 * an unsettled promise in a test is a five-second timeout with an unhelpful
 * message — or, in a watch run, a suite that appears stuck. Racing a timer
 * turns "never settled" into a normal, legible assertion failure.
 */
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

/**
 * Removing a known secret from text on its way to a person.
 *
 * This exists because "print the message, never the stack" was not enough: a
 * rejected Better Auth call quotes the offending request body, and for this
 * command that body holds the plaintext password. So the scrubber is the last
 * thing between the credential that owns the platform and the operator's
 * terminal scrollback, and the two ways it can fail are both silent — leaving
 * the secret in, or mangling text that never contained one.
 */
describe('withoutSecret', () => {
  it('replaces the secret with a visible marker', () => {
    expect(withoutSecret(`before ${TYPED} after`, TYPED)).toBe(
      `before ${REDACTED} after`,
    );
  });

  /** A body can name the same field twice; one pass has to catch all of them. */
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

  /**
   * The guard that matters most, because its absence is not a leak but a
   * catastrophe of a different kind: `''.split()` on an empty separator
   * explodes the text into characters, so an empty secret would turn every
   * message into a wall of markers. An empty password is refused upstream, but
   * this function must not depend on that.
   */
  it('is a no-op for an empty secret', () => {
    const text = 'connect ECONNREFUSED 127.0.0.1:5432';

    expect(withoutSecret(text, '')).toBe(text);
  });

  /**
   * The case a raw-only scrubber passes straight through while appearing to
   * work. A password containing a quote or a backslash never appears verbatim
   * in a serialized body — it appears escaped — so scrubbing only the raw form
   * would leave the whole password on the terminal, in a message that looks
   * redacted because the field name next to it was matched by nothing.
   */
  describe('the JSON-escaped form', () => {
    const AWKWARD = 'P4ss"word\\with-both';
    const body = `Invalid body: ${JSON.stringify({ password: AWKWARD })}`;

    it('is removed from a serialized body', () => {
      expect(withoutSecret(body, AWKWARD)).toBe(
        `Invalid body: {"password":"${REDACTED}"}`,
      );
    });

    /** Fixes the premise: the raw form genuinely is not present to be found. */
    it('is the only form present, so a raw-only scrub would leak it', () => {
      expect(body).not.toContain(AWKWARD);
      expect(body.split(AWKWARD).join(REDACTED)).toContain('P4ss');
    });

    /** Both forms in one text, since a message can quote and describe. */
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
  /**
   * `printf 'pw\nrest'`. The password is the first line and nothing else: the
   * alternative silently creates an account whose password contains a newline
   * and whatever followed it, which no operator will ever reproduce by hand.
   */
  it('takes only the first line', async () => {
    await expect(readPipedSecret(piped('pw\nrest'))).resolves.toBe('pw');
  });

  /** `echo` appends one; it is a terminator, not part of the secret. */
  it('drops a single trailing newline', async () => {
    await expect(readPipedSecret(piped(`${TYPED}\n`))).resolves.toBe(TYPED);
  });

  /** A heredoc on Windows line endings must not leave a `\r` on the end. */
  it('drops a trailing carriage return and newline', async () => {
    await expect(readPipedSecret(piped(`${TYPED}\r\n`))).resolves.toBe(TYPED);
  });

  /**
   * A pipe delivers whatever chunk sizes the kernel chose, so the split has to
   * happen after concatenation. Splitting per chunk would truncate any secret
   * that arrived in two pieces.
   */
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
  /**
   * The whole point of the interactive path. Readline echoes by default, so
   * the absence of the secret from the output stream is a property this code
   * has to actively maintain — and if the muting regresses, everything else
   * about the command still works, which is why only this assertion catches it.
   */
  it('writes the prompt and never echoes what was typed', async () => {
    const io = tty(TYPED);

    await expect(promptHiddenSecret(io, 'Password: ')).resolves.toBe(TYPED);

    expect(io.output.text).toContain('Password: ');
    expect(io.output.text).not.toContain(TYPED);
    // Not even a prefix: a per-keystroke echo would leave the first character.
    expect(io.output.text).not.toContain('TYPED');
  });

  /**
   * The operator's own newline was swallowed with the echo, so without this the
   * next line the command prints lands on the prompt and the terminal looks
   * hung mid-question.
   */
  it('ends the prompt line so later output starts on its own line', async () => {
    const io = tty(TYPED);

    await promptHiddenSecret(io, 'Password: ');

    expect(io.output.text.endsWith('\n')).toBe(true);
  });

  /**
   * Muting is a global side effect on the interface's writer, and a prompt that
   * throws must not leave a terminal that discards everything written after it.
   * Two prompts in a row is the observable form of that: the second prompt is
   * only visible if the first restored the writer.
   */
  it('restores output after the prompt is finished', async () => {
    const io = tty(TYPED, 'second');

    await promptHiddenSecret(io, 'Password: ');
    await promptHiddenSecret(io, 'Confirm password: ');

    expect(io.output.text).toContain('Confirm password: ');
    expect(io.output.text).not.toContain('second');
  });
});

/**
 * The interrupted prompt, which was a silent success.
 *
 * `promptHiddenSecret` used to settle only from readline's `question`
 * callback — and Ctrl+C, Ctrl+D and a closed stdin all close the interface
 * *without* ever invoking it. Ctrl+C included: raw mode disables ISIG, so the
 * key reaches readline instead of killing the process. The promise therefore
 * never settled, `main()` never resolved, nothing assigned `process.exitCode`,
 * the event loop drained, and Node exited **0**. An operator who pressed Ctrl+C
 * at the password prompt was told the account had been created.
 *
 * Every test here races a timer, because the regression is literally "never
 * settles": without the race a reintroduced bug would hang the suite instead of
 * failing it, and a hang reads as infrastructure trouble rather than as this.
 */
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

  /** A closed stdin: the pipe went away, or the terminal was disconnected. */
  it('resolves undefined when the input stream ends', async () => {
    const io = scriptedTty((input) => input.end());

    await expect(
      within(promptHiddenSecret(io, 'Password: ')),
    ).resolves.toBeUndefined();
  });

  /** Interrupting must not leave the typed characters behind either. */
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

  /**
   * Cancelling the *confirmation* is still a cancellation. It would otherwise
   * fall through to the equality check against `undefined` and be reported as a
   * mismatch — which tells the operator they mistyped when they did not.
   */
  it('reports an interruption at the confirmation as cancelled', async () => {
    const io = scriptedTty(
      // Answer the first prompt normally; interrupt the second.
      (input) => input.write(`${TYPED}\n`),
      (input) => input.write(CTRL_C),
    );

    await expect(within(readPassword(io))).resolves.toEqual({
      ok: false,
      reason: 'cancelled',
    });
  });

  /**
   * A cancellation is not an empty password. They exit the same way today, but
   * they are different events and the operator is told different things —
   * "cancelled" versus "a password is required" — so the reason has to survive.
   */
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

  /**
   * An empty pipe is a caller mistake — an unset variable, usually — and must
   * be a refusal rather than an account with an empty password.
   */
  it('reports an empty pipe rather than accepting an empty password', async () => {
    await expect(readPassword(piped())).resolves.toEqual({
      ok: false,
      reason: 'empty',
    });
  });

  /**
   * Asked twice, because a password that was never displayed cannot be checked
   * any other way, and the account it would create is the one nobody can reset.
   */
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

  /** An empty first answer is answered immediately; nothing to confirm. */
  it('reports an empty terminal answer without asking to confirm', async () => {
    const io = tty('', TYPED);

    await expect(readPassword(io)).resolves.toEqual({
      ok: false,
      reason: 'empty',
    });

    expect(io.output.text).not.toContain('Confirm password: ');
  });
});
