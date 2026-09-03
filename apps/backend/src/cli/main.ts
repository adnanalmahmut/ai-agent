import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { CliModule } from './cli.module';
import { dispatchCliCommand } from './dispatch';
import { RotationCliModule } from './rotation-cli.module';
import { SuperAdminBootstrap } from './super-admin.bootstrap';
import { EXIT } from './super-admin.command';
import { ManagedSecretRotationService } from '../features/control-plane/managed-secrets/managed-secret-rotation.service';

async function main(): Promise<number> {
  let built: { module: unknown; app: INestApplicationContext } | undefined;

  const context = async (
    module: Parameters<typeof NestFactory.createApplicationContext>[0],
  ): Promise<INestApplicationContext> => {
    if (built !== undefined) {
      if (built.module !== module) {
        throw new Error('one invocation may build only one composition root');
      }

      return built.app;
    }

    const app = await NestFactory.createApplicationContext(module, {
      logger: false,
      abortOnError: false,
    });

    built = { module, app };

    return app;
  };

  try {
    return await dispatchCliCommand(
      process.argv.slice(2),
      {
        input: process.stdin,
        output: process.stdout,
        error: process.stderr,
      },
      {
        bootstrap: async () =>
          (await context(CliModule)).get(SuperAdminBootstrap),
        rotation: async () =>
          (await context(RotationCliModule)).get(ManagedSecretRotationService),
      },
    );
  } finally {
    try {
      await built?.app.close();
    } catch (error) {
      process.stderr.write(
        `CLI teardown failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }\n`,
      );
    }
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // The message alone. See `runSuperAdminCreate` for why a stack must not be
    // printed on a path that has held a plaintext password.
    process.stderr.write(
      `CLI failed: ${
        error instanceof Error ? error.message : 'unknown error'
      }\n`,
    );
    process.exitCode = EXIT.failed;
  });
