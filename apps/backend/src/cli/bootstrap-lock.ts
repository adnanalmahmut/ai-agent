import { Client } from 'pg';

/**
 * The advisory-lock key for platform bootstrap.
 *
 * An arbitrary but fixed 64-bit constant. PostgreSQL advisory locks share one
 * global namespace per database, so the value only has to be distinctive; it is
 * recorded here rather than computed so a second lock added later can be seen
 * not to collide with it.
 */
const BOOTSTRAP_LOCK_KEY = 8_314_207_155_390_441n;

export type BootstrapLock = {
  /** Releases the lock and closes the connection holding it. */
  release: () => Promise<void>;
};

/**
 * Serializes first-run bootstrap across processes and hosts.
 *
 * The command's shape is check-then-write — no super_admin exists, therefore
 * create one — and that is a race whenever two operators run it at once, or one
 * operator runs it twice impatiently. Both would read an empty result and both
 * would create an account, which is not catastrophic but is exactly the
 * ambiguity a bootstrap command exists to avoid.
 *
 * A PostgreSQL advisory lock is the right instrument because the thing being
 * serialized has no row to lock: the check is over an *absence*. `SELECT ...
 * FOR UPDATE` cannot lock rows that are not there, and a unique constraint
 * cannot express "at most one user with this role" while the role column is a
 * comma-separated string owned by Better Auth.
 *
 * It is taken on a dedicated `pg` connection rather than through Prisma. A
 * session-level advisory lock belongs to one connection, and Prisma hands out
 * connections from a pool per query, so a lock taken through Prisma could be
 * released the moment that query returned its connection — or be held by a
 * connection the next query does not use. Owning the connection is what makes
 * the lock mean anything.
 *
 * `pg_try_advisory_lock` rather than `pg_advisory_lock`: a second operator
 * should be told that a bootstrap is already running, not silently blocked
 * behind it and then told the work is already done.
 */
export async function acquireBootstrapLock(
  connectionString: string,
  connectionTimeoutMillis: number,
): Promise<BootstrapLock | undefined> {
  /**
   * Bounded on purpose. `node-postgres` defaults this to zero, which means wait
   * forever — the same reasoning `database.config.ts` gives for setting it on
   * the Prisma pool, and it matters more here: an unreachable database would
   * hang the command indefinitely with the plaintext password resident in the
   * heap, instead of failing and letting the process exit.
   */
  const client = new Client({ connectionString, connectionTimeoutMillis });
  await client.connect();

  try {
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [BOOTSTRAP_LOCK_KEY.toString()],
    );

    if (!result.rows[0]?.locked) {
      await client.end();

      return undefined;
    }
  } catch (error) {
    // The connection is ours, so it is ours to close on the way out. Without
    // this a failed lock attempt leaks a PostgreSQL backend until the process
    // exits — survivable in a CLI, but the same code read as a template
    // elsewhere would not be.
    await client.end().catch(() => undefined);

    throw error;
  }

  return {
    release: async () => {
      // Unlocking explicitly is courtesy, not correctness: ending the session
      // releases every advisory lock it holds. Both are attempted, and neither
      // failure is worth reporting over the command's own outcome.
      await client
        .query('SELECT pg_advisory_unlock($1)', [BOOTSTRAP_LOCK_KEY.toString()])
        .catch(() => undefined);
      await client.end().catch(() => undefined);
    },
  };
}
