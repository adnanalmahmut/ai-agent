import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { CliModule } from './cli/cli.module';
import { dispatchCliCommand } from './cli/dispatch';
import { SuperAdminBootstrap } from './cli/super-admin.bootstrap';
import { EXIT } from './cli/super-admin.command';

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
  let app: INestApplicationContext | undefined;

  try {
    return await dispatchCliCommand(
      process.argv.slice(2),
      {
        input: process.stdin,
        output: process.stdout,
        error: process.stderr,
      },
      async () => {
        app = await NestFactory.createApplicationContext(CliModule, {
          /**
           * Silenced, not buffered. `bufferLogs` holds Nest's startup lines
           * until something flushes them — and a failed bootstrap flushes them,
           * so the operator's error arrives wrapped in dependency-injection
           * noise with the real cause somewhere in the middle. This audience is
           * a person at a terminal; the command's own two streams are the whole
           * interface.
           */
          logger: false,
          abortOnError: false,
        });

        return app.get(SuperAdminBootstrap);
      },
    );
  } finally {
    // Only if it was ever built. Closing drains Prisma, so skipping it on the
    // usage path is also what keeps that path free of a database connection.
    await app?.close();
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
      `super-admin CLI failed: ${
        error instanceof Error ? error.message : 'unknown error'
      }\n`,
    );
    process.exitCode = EXIT.failed;
  });
