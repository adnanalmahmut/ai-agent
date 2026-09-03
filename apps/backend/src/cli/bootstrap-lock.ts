import { Client } from 'pg';

const BOOTSTRAP_LOCK_KEY = 8_314_207_155_390_441n;

export type BootstrapLock = {
  release: () => Promise<void>;
};

export async function acquireBootstrapLock(
  connectionString: string,
  connectionTimeoutMillis: number,
): Promise<BootstrapLock | undefined> {
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
