import type { ManagedSecretRotationService } from '../control-plane/managed-secrets/managed-secret-rotation.service';
import { ROTATE_USAGE, runRotateKey } from './rotate-key.command';
import type { SuperAdminBootstrap } from './super-admin.bootstrap';
import type { CommandIo } from './super-admin.command';
import { EXIT, USAGE, runSuperAdminCreate } from './super-admin.command';

/**
 * What the CLI can build, each behind a thunk.
 *
 * Thunks rather than constructed instances, so `--help` and a mistyped flag are
 * answered without building a Nest context or opening a database connection —
 * and so a test can assert that neither was resolved.
 */
export type CliDependencies = {
  bootstrap: () => Promise<Pick<SuperAdminBootstrap, 'run'>>;
  rotation: () => Promise<Pick<ManagedSecretRotationService, 'rotateAll'>>;
};

/**
 * The top-level help.
 *
 * Lists the commands and defers their flags to their own `--help`, because a
 * combined page grows past what is useful the moment a third command lands.
 */
export const CLI_USAGE = `Usage: cli <command> [options]

Commands:
  super-admin:create           Create the platform's first super administrator.
  managed-secret:rotate-key    Re-encrypt managed secrets under the active key.

Run a command with --help for its options.
`;

/**
 * Which command ran, and what the process should exit with.
 *
 * Extracted from `cli.ts` for the reason `worker.runtime.ts` and
 * `worker.shutdown.ts` already were: `cli.ts` runs on import, so nothing can
 * exercise the real dispatch — only a copy of it, which keeps passing after the
 * real one changes. The failures that hides are quiet ones: `--help` exiting
 * non-zero, an unknown command exiting zero and looking like success to a
 * script, or a second command silently unreachable.
 *
 * Everything that touches the process — `process.argv`, the real streams,
 * building and closing the Nest context — stays in `cli.ts`. What is here is
 * the decision, which is the part worth testing.
 */
export async function dispatchCliCommand(
  argv: readonly string[],
  io: CommandIo,
  dependencies: CliDependencies,
): Promise<number> {
  const [command, ...rest] = argv;

  /**
   * Asking for help succeeds; being given nothing does not. A script that
   * invoked the CLI with no command made a mistake and must be able to see it
   * in the exit code, while an operator who typed `--help` got exactly what
   * they asked for.
   */
  if (command === undefined || command === '--help' || command === '-h') {
    io.output.write(CLI_USAGE);

    return command === undefined ? EXIT.usage : EXIT.ok;
  }

  if (command === 'super-admin:create') {
    if (wantsHelp(rest)) {
      io.output.write(USAGE);

      return EXIT.ok;
    }

    return runSuperAdminCreate(rest, io, dependencies.bootstrap);
  }

  if (command === 'managed-secret:rotate-key') {
    if (wantsHelp(rest)) {
      io.output.write(ROTATE_USAGE);

      return EXIT.ok;
    }

    return runRotateKey(rest, io, dependencies.rotation);
  }

  io.error.write(`Unknown command: ${command}\n\n${CLI_USAGE}`);

  return EXIT.usage;
}

/**
 * Handled here rather than in each command's parser so that asking for help can
 * never be mistaken for an argument error, and never reaches a parser that
 * would have to know about it.
 */
function wantsHelp(argv: readonly string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}
