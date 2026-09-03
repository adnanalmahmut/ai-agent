import type { ManagedSecretRotationService } from '../features/control-plane/managed-secrets/managed-secret-rotation.service';
import { ROTATE_USAGE, runRotateKey } from './rotate-key.command';
import type { SuperAdminBootstrap } from './super-admin.bootstrap';
import type { CommandIo } from './super-admin.command';
import { EXIT, USAGE, runSuperAdminCreate } from './super-admin.command';

export type CliDependencies = {
  bootstrap: () => Promise<Pick<SuperAdminBootstrap, 'run'>>;
  rotation: () => Promise<Pick<ManagedSecretRotationService, 'rotateAll'>>;
};

export const CLI_USAGE = `Usage: cli <command> [options]

Commands:
  super-admin:create           Create the platform's first super administrator.
  managed-secret:rotate-key    Re-encrypt managed secrets under the active key.

Run a command with --help for its options.
`;

export async function dispatchCliCommand(
  argv: readonly string[],
  io: CommandIo,
  dependencies: CliDependencies,
): Promise<number> {
  const [command, ...rest] = argv;

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

function wantsHelp(argv: readonly string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}
