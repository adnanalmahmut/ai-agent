import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';

/**
 * Reading a password without leaving it somewhere it can be read again.
 *
 * The threat here is not interception, it is persistence. A password passed as
 * `--password hunter2` is written verbatim into shell history, is visible in
 * `ps` output to every user on the host for the lifetime of the process, and
 * is captured by any command auditing the operator has enabled. A password
 * passed through the environment survives in `/proc/<pid>/environ` and in any
 * crash reporter or process dump that serializes the environment. Neither is
 * acceptable for the credential that owns the platform, so this module provides
 * the only two mechanisms that do not persist: an interactive prompt that does
 * not echo, and a pipe.
 *
 * Both are deliberately the *only* mechanisms. A flag or an environment
 * variable would be more convenient and would silently become how everyone does
 * it.
 */

/** What a removed secret is replaced with, so its absence is visible. */
export const REDACTED = '[redacted]';

/**
 * Removes a known secret from text that is about to be shown to someone.
 *
 * Necessary because "do not print the stack or the cause" turned out not to be
 * enough. Better Auth's validation errors quote the offending request body, and
 * for this command that body holds the plaintext password — so the *message*
 * alone, the one thing the error handler deliberately kept, is a leak. Found by
 * a canary test, not by reading the code, which is the argument for the canary
 * test.
 *
 * The JSON-escaped form is scrubbed as well as the raw one. A password
 * containing a quote or a backslash appears in a serialized body escaped, and a
 * scrubber that only knew the raw form would pass it straight through while
 * looking like it worked.
 *
 * This removes one known value; it is not a general redactor and must not be
 * mistaken for one. It is sound here only because the caller holds the exact
 * secret at the point of the write.
 */
export function withoutSecret(text: string, secret: string): string {
  if (secret.length === 0) return text;

  const escaped = JSON.stringify(secret).slice(1, -1);
  const scrubbed = text.split(secret).join(REDACTED);

  return escaped === secret ? scrubbed : scrubbed.split(escaped).join(REDACTED);
}

export type SecretIo = {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream;
};

/** True when a person is typing, false when the caller is piping. */
export function isInteractive(io: SecretIo): boolean {
  return io.input.isTTY === true;
}

/**
 * Reads a secret from a non-TTY stdin.
 *
 * For automation: `printf '%s' "$password" | pnpm ... super-admin:create`.
 * Only the first line is taken, so a trailing newline from `echo` or a heredoc
 * does not become part of the password — a mismatch that would otherwise
 * surface much later as an inexplicable failed sign-in.
 */
export async function readPipedSecret(io: SecretIo): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of io.input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/, 1)[0] ?? '';
}

/**
 * Prompts on a TTY without echoing what is typed.
 *
 * `readline` has no supported "hidden input" mode, so the standard approach is
 * to intercept the interface's own output writer and drop everything it would
 * have echoed after the prompt itself. The muting is installed *before* the
 * question is asked and removed in a `finally`, so a throw mid-prompt cannot
 * leave a terminal that silently discards output.
 *
 * Not written: a masking character per keystroke. It leaks the password length
 * to anyone watching the screen and buys nothing over a blank field.
 */
export async function promptHiddenSecret(
  io: SecretIo,
  prompt: string,
): Promise<string | undefined> {
  const rl = createInterface({
    input: io.input,
    output: io.output,
    terminal: true,
  }) as Interface & { _writeToOutput?: unknown };

  let muted = false;

  rl._writeToOutput = (text: string) => {
    if (!muted) io.output.write(text);
  };

  try {
    const answer = await new Promise<string | undefined>((resolve) => {
      /**
       * `close` is what makes an interrupted prompt observable, and without it
       * this function silently breaks the whole command.
       *
       * Ctrl+C, Ctrl+D and a closed stdin all close the interface *without*
       * ever invoking `question`'s callback — Ctrl+C included, because raw mode
       * has disabled ISIG and readline handles the keypress itself rather than
       * the process dying. A promise that only settles from that callback
       * therefore never settles at all: `main()` never resolves, nothing
       * assigns `process.exitCode`, the event loop drains, and Node exits **0**.
       * An operator who pressed Ctrl+C at the prompt would be told the account
       * was created.
       *
       * Registered before `question` so no ordering can lose the event. Settling
       * twice is harmless — the second `resolve` is a no-op — which is what lets
       * the `finally` close the interface unconditionally.
       */
      rl.on('close', () => {
        resolve(undefined);
      });

      rl.question(prompt, (value) => {
        resolve(value);
      });

      muted = true;
    });

    // The newline the operator typed was swallowed with everything else, so the
    // next line the command prints would otherwise land on the prompt.
    io.output.write('\n');

    return answer;
  } finally {
    muted = false;
    rl.close();
  }
}

/**
 * Obtains the password by whichever mechanism fits the caller.
 *
 * Interactive callers are asked twice, because a mistyped password that is
 * never displayed cannot be noticed any other way, and the account it would
 * create is the one nobody can reset.
 */
export async function readPassword(
  io: SecretIo,
): Promise<
  | { ok: true; password: string }
  | { ok: false; reason: 'mismatch' | 'empty' | 'cancelled' }
> {
  if (!isInteractive(io)) {
    const piped = await readPipedSecret(io);

    return piped.length === 0
      ? { ok: false, reason: 'empty' }
      : { ok: true, password: piped };
  }

  const password = await promptHiddenSecret(io, 'Password: ');

  // `undefined` is an interrupted prompt, which is a different thing from an
  // empty one and must not be reported as "a password is required".
  if (password === undefined) return { ok: false, reason: 'cancelled' };
  if (password.length === 0) return { ok: false, reason: 'empty' };

  const confirmation = await promptHiddenSecret(io, 'Confirm password: ');

  if (confirmation === undefined) return { ok: false, reason: 'cancelled' };

  return password === confirmation
    ? { ok: true, password }
    : { ok: false, reason: 'mismatch' };
}
