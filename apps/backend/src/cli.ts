import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { CliModule } from './cli/cli.module';
import { dispatchCliCommand } from './cli/dispatch';
import { RotationCliModule } from './cli/rotation-cli.module';
import { SuperAdminBootstrap } from './cli/super-admin.bootstrap';
import { EXIT } from './cli/super-admin.command';
import { ManagedSecretRotationService } from './control-plane/managed-secrets/managed-secret-rotation.service';

/**
 * The operator CLI.
 *
 * A third entrypoint beside `main.ts` and `worker.ts`, and an application
 * context rather than a server: it performs one action and exits. It exists
 * because the platform has a chicken-and-egg problem — every way of granting
 * the super administrator role requires a super administrator — and the only
 * safe place to break that cycle is a command an operator runs deliberately,
 * never something the application does to itself at boot.
 *
 * Auto-creating an administrator at startup would mean every deployment of this
 * image, everywhere, briefly contains an account whose credentials were decided
 * by configuration. That is a far worse failure than an operator having to run
 * one command.
 *
 * This file is wiring only: the process's arguments, the process's streams, and
 * the lifetime of the Nest context. The decision about which command ran lives
 * in `cli/dispatch.ts`, where a test can reach it.
 */
async function main(): Promise<number> {
  /**
   * Built on demand, and only once the arguments and the password are known to
   * be good. Constructing it parses the whole authentication configuration and
   * connects to PostgreSQL, and none of that should stand between an operator
   * and a usage message — least of all on a host where the database is the
   * thing that is broken.
   */
  let built: { module: unknown; app: INestApplicationContext } | undefined;

  /**
   * Builds the one composition the invoked command needs.
   *
   * The two commands have deliberately disjoint roots — `CliModule` has the
   * authentication stack and no master key, `RotationCliModule` has the master
   * key and no authentication stack — so which one is constructed is itself a
   * privilege boundary. Only the command that ran gets its own, and the other's
   * authority is never present in the process at all.
   *
   * The memo is keyed by module rather than being a bare `??=`. One invocation
   * runs one command, so today nothing asks for the second root — but a memo
   * that ignored its argument would make that a property of the dispatch shape
   * rather than of this function, and the failure it hides is a command silently
   * handed the wrong composition. Refusing is the honest answer: a single
   * invocation that needed both roots would be a privilege boundary crossed, not
   * a caching question.
   */
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
      /**
       * Silenced, not buffered. `bufferLogs` holds Nest's startup lines until
       * something flushes them — and a failed bootstrap flushes them, so the
       * operator's error arrives wrapped in dependency-injection noise with the
       * real cause somewhere in the middle. This audience is a person at a
       * terminal; the command's own two streams are the whole interface.
       */
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
    /**
     * Only if it was ever built, and never at the cost of the command's own exit
     * code. Closing drains Prisma, so skipping it on the usage path is also what
     * keeps that path free of a database connection — and a `close()` that
     * rejects must not turn a completed rotation into a failure, because that
     * code is what the runbook's key-retirement gate reads. A teardown problem
     * after the work committed is worth a line on stderr and nothing more.
     */
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
