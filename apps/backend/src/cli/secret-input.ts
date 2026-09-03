import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';

export const REDACTED = '[redacted]';

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

export function isInteractive(io: SecretIo): boolean {
  return io.input.isTTY === true;
}

export async function readPipedSecret(io: SecretIo): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of io.input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/, 1)[0] ?? '';
}

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
