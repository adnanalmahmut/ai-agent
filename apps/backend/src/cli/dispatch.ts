import type { SuperAdminBootstrap } from './super-admin.bootstrap';
import type { CommandIo } from './super-admin.command';
import { EXIT, USAGE, runSuperAdminCreate } from './super-admin.command';

/**
 * Which command ran, and what the process should exit with.
 *
 * Extracted from `cli.ts` for the reason `worker.runtime.ts` and
 * `worker.shutdown.ts` already were: `cli.ts` runs on import, so nothing can
 * exercise the real dispatch — only a copy of it, which keeps passing after the
 * real one changes. The failures that hides are quiet ones: `--help` exiting
 * non-zero, an unknown command exiting zero and looking like success to a
 * script, or a future second command silently unreachable.
 *
 * Everything that touches the process — `process.argv`, the real streams,
 * building and closing the Nest context — stays in `cli.ts`. What is here is
 * the decision, which is the part worth testing.
 */
export async function dispatchCliCommand(
  argv: readonly string[],
  io: CommandIo,
  resolveBootstrap: () => Promise<Pick<SuperAdminBootstrap, 'run'>>,
): Promise<number> {
  const [command, ...rest] = argv;

  /**
   * Asking for help succeeds; being given nothing does not. A script that
   * invoked the CLI with no command made a mistake and must be able to see it
   * in the exit code, while an operator who typed `--help` got exactly what
   * they asked for.
   */
  if (command === undefined || command === '--help' || command === '-h') {
    io.output.write(USAGE);

    return command === undefined ? EXIT.usage : EXIT.ok;
  }

  if (command !== 'super-admin:create') {
    io.error.write(`Unknown command: ${command}\n\n${USAGE}`);

    return EXIT.usage;
  }

  return runSuperAdminCreate(rest, io, resolveBootstrap);
}
