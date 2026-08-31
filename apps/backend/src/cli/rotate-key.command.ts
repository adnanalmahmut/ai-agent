import type {
  ManagedSecretRotationService,
  RotationOutcome,
  RotationReport,
} from '../control-plane/managed-secrets/managed-secret-rotation.service';
import { MAX_ROTATION_BATCH_SIZE } from '../control-plane/managed-secrets/managed-secret-rotation.service';
import type { CommandIo } from './super-admin.command';

/**
 * Exit codes, fixed and documented.
 *
 * `incomplete` is separate from `failed` because they call for different
 * actions. Incomplete means the sweep ran correctly and some rows did not
 * rotate — an unreadable credential to re-enter, or a row someone changed
 * mid-run that a re-run will pick up. Failed means the sweep itself did not
 * finish, and nothing about the table can be concluded from it.
 *
 * A rotation that changed nothing because everything was already current exits
 * 0: the operator's intent was "make the table current", and it is.
 */
export const ROTATE_EXIT = {
  ok: 0,
  usage: 1,
  incomplete: 2,
  failed: 3,
} as const;

export const ROTATE_USAGE = `Usage: managed-secret:rotate-key [--batch-size <n>] [--dry-run]

Re-encrypts stored managed secrets under the configured active encryption key
version (APP_ENCRYPTION_ACTIVE_KEY_VERSION). A secret already sealed under that
version is left alone, so running this twice is the same as running it once, and
an interrupted run is resumed by running it again.

Rotating a secret does not change its value. Older keys listed in
APP_ENCRYPTION_DECRYPT_KEYS are still required to read rows that have not been
rotated yet, and this command never removes a key: retiring one is a separate,
later decision made only after a --dry-run reports nothing left to rotate and
the rollback window for the previous image has passed.

  --batch-size <n>  Rows to read per page, 1 to ${MAX_ROTATION_BATCH_SIZE}. Default 50.
  --dry-run         Report what would change and write nothing.
`;

type ParsedRotateArgs =
  | { ok: true; batchSize: number | undefined; dryRun: boolean }
  | { ok: false; message: string };

/**
 * Parses `--batch-size` and `--dry-run`.
 *
 * Hand-rolled for the reason `parseArgs` in `super-admin.command.ts` is: two
 * flags do not justify a dependency, and there is no CLI framework here to be
 * consistent with.
 *
 * Unlike that command, repeating a value here is safe — a batch size is not a
 * credential — so refusals quote what they were given, which is what makes a
 * typo diagnosable.
 */
export function parseRotateArgs(argv: readonly string[]): ParsedRotateArgs {
  let batchSize: number | undefined;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--dry-run') {
      dryRun = true;
      continue;
    }

    if (token === '--batch-size') {
      const value = argv[index + 1];
      index += 1;

      if (value === undefined || value.startsWith('--')) {
        return { ok: false, message: '--batch-size requires a value' };
      }

      // Parsed strictly. `Number` would accept '1e3', ' 12 ', and '0x10', and
      // an operator who typed one of those did not mean what it resolves to.
      if (!/^[0-9]+$/.test(value)) {
        return {
          ok: false,
          message: `--batch-size must be a whole number, not "${value}"`,
        };
      }

      batchSize = Number.parseInt(value, 10);

      if (batchSize < 1 || batchSize > MAX_ROTATION_BATCH_SIZE) {
        return {
          ok: false,
          message: `--batch-size must be between 1 and ${MAX_ROTATION_BATCH_SIZE}, not ${batchSize}`,
        };
      }

      continue;
    }

    return { ok: false, message: `Unexpected argument: ${token}` };
  }

  return { ok: true, batchSize, dryRun };
}

/**
 * Runs the command and returns an exit code.
 *
 * Separated from the process entrypoint for the same reason the super-admin
 * command is: a test can drive it with fake streams and a fake service and
 * assert both the code and everything written to the two streams — which is
 * where a credential would surface if one ever escaped.
 *
 * The service is resolved lazily, so an argument mistake is refused before a
 * Nest context is built and a database is touched.
 */
export async function runRotateKey(
  argv: readonly string[],
  io: CommandIo,
  resolveRotation: () => Promise<
    Pick<ManagedSecretRotationService, 'rotateAll'>
  >,
): Promise<number> {
  const args = parseRotateArgs(argv);

  if (!args.ok) {
    io.error.write(`${args.message}\n\n${ROTATE_USAGE}`);

    return ROTATE_EXIT.usage;
  }

  let report: RotationReport;

  try {
    const rotation = await resolveRotation();
    report = await rotation.rotateAll({
      batchSize: args.batchSize,
      dryRun: args.dryRun,
    });
  } catch (error) {
    /**
     * The message only, and never the stack or cause. This command runs beside
     * credential material, and a Prisma or configuration error's own text is
     * the largest surface here that was not written with that in mind.
     */
    io.error.write(
      `Rotation failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );

    return ROTATE_EXIT.failed;
  }

  io.output.write(renderReport(report, args.dryRun));

  /**
   * What "nothing left to do" means, and why a dry run counts differently.
   *
   * Exit 0 is what the runbook's retirement gate reads before an operator
   * deletes a key permanently, so it has to mean *the table is current* — not
   * merely *this invocation hit no errors*. On a dry run the rows that are
   * still on an old key are exactly `wouldRotate`, and reporting success while
   * they exist would invite retiring a key those rows still depend on.
   *
   * `concurrentlyModified` cannot occur on a dry run, which writes nothing.
   */
  const outstanding = args.dryRun
    ? report.wouldRotate + report.unreadable + report.unknownSlot
    : report.unreadable + report.concurrentlyModified + report.unknownSlot;

  return outstanding > 0 ? ROTATE_EXIT.incomplete : ROTATE_EXIT.ok;
}

/**
 * The report an operator reads.
 *
 * Counts and slot names. Slot names are code-owned registry identifiers such as
 * `openai.api_key`, not values, and naming the specific rows that need
 * attention is the difference between a report that can be acted on and one
 * that only says a number.
 */
function renderReport(report: RotationReport, dryRun: boolean): string {
  const lines: string[] = [];

  lines.push(
    dryRun
      ? `Dry run: examined ${report.examined} secret(s), wrote nothing.`
      : `Examined ${report.examined} secret(s).`,
  );

  const counts = [
    dryRun ? `${report.wouldRotate} would rotate` : `${report.rotated} rotated`,
    `${report.alreadyActive} already current`,
  ];

  if (report.unreadable > 0) counts.push(`${report.unreadable} unreadable`);
  if (report.concurrentlyModified > 0) {
    counts.push(`${report.concurrentlyModified} changed during the run`);
  }
  if (report.unknownSlot > 0) {
    counts.push(`${report.unknownSlot} not in this build's registry`);
  }

  lines.push(`  ${counts.join(', ')}.`);

  const attention = report.outcomes.filter(needsAttention);

  if (attention.length > 0) {
    lines.push('', 'Needs attention:');

    for (const outcome of attention) {
      lines.push(`  ${outcome.key}: ${EXPLANATION[outcome.disposition]}`);
    }

    lines.push(
      '',
      'An unreadable secret is one no configured key can decrypt: either the key',
      'that sealed it is missing from APP_ENCRYPTION_DECRYPT_KEYS, or the row was',
      'altered. Re-enter that credential through the control plane. A secret that',
      'changed during the run was left as the newer value and rotates on a re-run.',
    );
  }

  return `${lines.join('\n')}\n`;
}

/**
 * The dispositions that put a row in the report's "needs attention" list.
 *
 * A type predicate rather than an inline boolean, so `EXPLANATION` below can be
 * keyed to exactly these three. `Record<string, string>` would have compiled
 * with any of them missing and rendered `undefined` beside a slot name; typed
 * this way, adding a disposition that needs explaining is a compile error at the
 * one place that has to know about it.
 */
function needsAttention(
  outcome: RotationOutcome,
): outcome is RotationOutcome & { disposition: AttentionDisposition } {
  return (
    outcome.disposition === 'unreadable' ||
    outcome.disposition === 'concurrentlyModified' ||
    outcome.disposition === 'unknownSlot'
  );
}

type AttentionDisposition =
  'unreadable' | 'concurrentlyModified' | 'unknownSlot';

const EXPLANATION: Record<AttentionDisposition, string> = {
  unreadable: 'no configured key could decrypt it; left unchanged',
  concurrentlyModified: 'changed while rotating; left as the newer value',
  unknownSlot: 'not a managed-secret slot this build defines; left unchanged',
};
