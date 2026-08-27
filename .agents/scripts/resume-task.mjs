#!/usr/bin/env node
/**
 * Compact-safe resume for a bounded PR train.
 *
 * This is the integration boundary: it collects real Git and GitHub evidence,
 * hands it to the pure model in `pr-train.mjs`, and prints what a fresh agent
 * needs to take over. It is read-only by construction — it runs inspection
 * commands and nothing else.
 *
 * A compaction is a process restart, not continuity of memory. Everything this
 * prints must therefore come from evidence, never from what a previous turn
 * believed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  DEFAULT_TRAIN_LIMIT,
  TRAIN_LIMIT_CEILING,
  analyze,
  dashboardFileDecision,
  parsePorcelainZ,
} from './pr-train.mjs';

/** Inspection only. Every call here reads state; none of them change it. */
function runRaw(command, args, fallback = '') {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return fallback;
  }
}

function run(command, args, fallback = '') {
  const output = runRaw(command, args, null);
  return output === null ? fallback : output.trim();
}

const root = run('git', ['rev-parse', '--show-toplevel']);
if (!root) {
  console.error('agents:resume must be run inside a Git repository');
  process.exit(2);
}
process.chdir(root);

const todoPath = process.env.AGENTS_TODO ?? 'TODO.md';

const fileDecision = dashboardFileDecision({
  exists: existsSync(todoPath),
  tracked: run('git', ['ls-files', '--error-unmatch', todoPath], '') === todoPath,
  ignored: run('git', ['check-ignore', todoPath], '') === todoPath,
});

if (!fileDecision.ok) {
  console.error(`${todoPath}: ${fileDecision.message}`);
  process.exit(2);
}

const todo = readFileSync(todoPath, 'utf8');

// ---------------------------------------------------------------------------
// Git evidence
// ---------------------------------------------------------------------------

const branch = run('git', ['branch', '--show-current'], '(detached)');
const head = run('git', ['rev-parse', 'HEAD'], 'unknown');
const status = run('git', ['status', '--short', '--branch'], '(status unavailable)');
const log = run('git', ['log', '--oneline', '--decorate', '--graph', '-n', '12'], '(log unavailable)');
const unstaged = run('git', ['diff', '--stat']);
const staged = run('git', ['diff', '--cached', '--stat']);
const mainSha = run('git', ['rev-parse', 'origin/main'], run('git', ['rev-parse', 'main'], ''));

/**
 * Paths with uncommitted content. Reported so inherited work is visible before
 * any edit; the model turns this into an explicit do-not-discard finding.
 *
 * Read NUL-separated and untrimmed on purpose: `run` trims, which eats the
 * leading space of the first porcelain record, and a newline split cannot
 * represent a path containing whitespace. Record parsing — including the
 * two-record rename form — lives in the pure module so it is tested against a
 * real fixture.
 */
const dirtyPaths = parsePorcelainZ(runRaw('git', ['status', '--porcelain', '-z']));

// ---------------------------------------------------------------------------
// GitHub evidence
// ---------------------------------------------------------------------------

const PR_FIELDS =
  'number,title,state,isDraft,baseRefName,headRefName,headRefOid,url,mergeable,mergeStateStatus,statusCheckRollup';

/** Rolls the per-check array up to one word, so the model compares one value. */
function rollup(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return null;
  const verdicts = checks.map((check) => check.conclusion || check.status || '').map(String);
  if (verdicts.some((verdict) => /FAILURE|TIMED_OUT|CANCELLED|ACTION_REQUIRED|ERROR/i.test(verdict))) return 'FAILURE';
  if (verdicts.some((verdict) => /PENDING|QUEUED|IN_PROGRESS|WAITING|REQUESTED/i.test(verdict))) return 'PENDING';
  if (verdicts.every((verdict) => /SUCCESS|NEUTRAL|SKIPPED/i.test(verdict))) return 'SUCCESS';
  return null;
}

function fetchPr(number) {
  const raw = run('gh', ['pr', 'view', String(number), '--json', PR_FIELDS]);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return {
      number: data.number,
      title: data.title,
      state: data.state,
      isDraft: data.isDraft,
      baseRefName: data.baseRefName,
      headRefName: data.headRefName,
      headSha: data.headRefOid,
      url: data.url,
      mergeable: data.mergeable,
      mergeStateStatus: data.mergeStateStatus,
      checks: rollup(data.statusCheckRollup),
    };
  } catch {
    return null;
  }
}

// Parse once with no GitHub evidence to learn which PR numbers to ask about,
// then re-analyze with the evidence. Cheaper and more precise than listing every
// PR in the repository.
const preliminary = analyze(todo, {});
const prNumbers = (preliminary.train?.slots ?? [])
  .map((slot) => slot.prNumber)
  .filter((number) => number !== null);

const prs = {};
let githubAvailable = false;
for (const number of prNumbers) {
  const data = fetchPr(number);
  if (data) {
    prs[number] = data;
    githubAvailable = true;
  }
}

const result = analyze(todo, { mainSha, branch, head, dirtyPaths, prs });

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const out = (line = '') => console.log(line);

out();
out('=== AGENT RESUME SNAPSHOT ===');
out(`Repository: ${root}`);
out(`Dashboard: ${todoPath} (${fileDecision.severity === 'ok' ? 'local, ignored' : fileDecision.severity.toUpperCase()})`);
if (fileDecision.severity === 'warn') out(`  WARNING: ${fileDecision.message}`);
out(`Branch: ${branch}`);
out(`HEAD: ${head}`);
out(`origin/main: ${mainSha || '(unavailable)'}`);
out(
  `GitHub evidence: ${
    githubAvailable
      ? `${Object.keys(prs).length} of ${prNumbers.length} recorded PR(s) read`
      : prNumbers.length === 0
        ? '(no PR numbers recorded yet, so nothing to read)'
        : '(gh unavailable or unauthenticated; PR-level drift NOT checked)'
  }`,
);

if (!result.valid) {
  out();
  out('=== DASHBOARD DOES NOT PARSE — FAILING CLOSED ===');
  for (const error of result.errors) out(`- ${error}`);
  if (result.needsMigration) {
    out();
    out('This dashboard predates the bounded PR train. Migrate it:');
    out('  - rename "# ACTIVE PR" to "# ACTIVE PR TRAIN"');
    out('  - add: Train, Train state, Anchor main SHA, Configured max open PRs, Current PR');
    out('  - restate the active PR as "## PR 1 — <task id>" with Branch/Base/PR number/Head SHA/State/Depends on/Dependency type/Next exact action');
    out('  - add "# CURRENT CHECKPOINT" and "# UNRESOLVED FINDINGS" sections');
    out('  See docs/agent-harness.md for the full schema.');
  }
  out();
  out('Reconstruct the dashboard from Git, GitHub, and the tracked exec plan.');
  out('Do NOT infer train state from conversation history.');
  out();
  out(`--- git status ---\n${status}`);
  out();
  out(`--- recent history ---\n${log}`);
  process.exit(2);
}

const { train } = result;

out();
out('--- train ---');
out(`Train: ${train.id ?? '(unnamed)'}`);
out(`Train state: ${train.state ?? '(unrecorded)'}`);
out(`Anchor main SHA: ${train.anchorMainSha ?? '(unrecorded)'}`);
out(`Configured max open PRs: ${train.configuredLimit} (default ${DEFAULT_TRAIN_LIMIT}, supported ceiling ${TRAIN_LIMIT_CEILING})`);
out(`CAPACITY RECORDED: ${result.limit.occupied} of ${result.limit.limit} slots occupied per the dashboard`);
out(`  ${result.limit.message}`);
out(
  `NEW-SLOT PROGRESSION ${result.progression.allowed ? 'ALLOWED' : 'BLOCKED'}: ${result.progression.effectiveOccupancy} of ${result.progression.limit} slots live by evidence`,
);
if (!result.progression.allowed) {
  for (const reason of result.progression.reasons) out(`  - ${reason}`);
}
if (result.progression.confirmedReleased.length > 0) {
  out(`  confirmed released: PR ${result.progression.confirmedReleased.join(', PR ')}`);
}
if (train.declaredMergeOrder) out(`Declared merge order: ${train.declaredMergeOrder}`);

out();
out('--- slots ---');
for (const slot of train.slots) {
  const actual = slot.prNumber === null ? null : prs[slot.prNumber];
  const dependency =
    slot.dependsOn.length === 0
      ? 'independent (base main)'
      : `${slot.dependencyType ?? 'stacked'} on PR ${slot.dependsOn.join(', PR ')}${slot.dependencyReason ? ` — ${slot.dependencyReason}` : ''}`;
  out(`PR ${slot.slot} — ${slot.taskId ?? '(no task id)'} [${slot.state}]`);
  out(`  branch: ${slot.branch ?? '(none)'}   base: ${slot.base ?? '(none)'}`);
  out(`  pr: ${slot.prNumber === null ? '(not opened)' : `#${slot.prNumber}`}   recorded head: ${slot.headSha ?? '(none)'}`);
  if (actual) {
    out(`  github: ${actual.state}${actual.isDraft ? ' (draft)' : ''}   head: ${actual.headSha}   base: ${actual.baseRefName}`);
    out(`  mergeable: ${actual.mergeable ?? '?'}/${actual.mergeStateStatus ?? '?'}   checks: ${actual.checks ?? 'unknown'}`);
  }
  out(`  dependency: ${dependency}`);
  if (slot.mergeOrderConstraint) out(`  merge order: ${slot.mergeOrderConstraint}`);
  out(`  next: ${slot.nextAction ?? '(unrecorded)'}`);
  const remaining = slot.checklist.filter((item) => !item.done).map((item) => item.label);
  out(`  checklist: ${slot.checklist.length - remaining.length}/${slot.checklist.length} done${remaining.length ? `; next "${remaining[0]}"` : ''}`);
}

if (result.eligibility.length > 0) {
  out();
  out('--- planned slot eligibility ---');
  for (const entry of result.eligibility) {
    out(`PR ${entry.slot} — ${entry.taskId ?? '(no task id)'}: ${entry.eligible ? 'MAY START' : 'MAY NOT START'}`);
    for (const reason of entry.reasons) out(`  - ${reason}`);
  }
}

if (result.siblings.length > 0) {
  out();
  out('--- sibling groups (derived, not declared) ---');
  for (const group of result.siblings) {
    const shared = group.sharedDependency === 'main' ? 'main' : `PR ${group.sharedDependency.split(',').join(', PR ')}`;
    out(`PR ${group.members.join(', PR ')} share ${shared} and do not depend on each other.`);
  }
}

out();
out('--- current ---');
if (result.current) {
  out(`Current PR: ${result.current.slot} — ${result.current.taskId ?? ''} [${result.current.state}]${result.inferred ? '  (INFERRED: "Current PR" was unrecorded)' : ''}`);
} else {
  out('Current PR: none live');
}
out(`Next legitimate action: ${result.nextAction}`);

if (result.warnings.length > 0) {
  out();
  out('--- dashboard warnings ---');
  for (const warning of result.warnings) out(`- ${warning}`);
}

// Ordered most-actionable first, so a truncated read still surfaces the things
// that change what the agent should do next.
const SEVERITY_ORDER = ['contradiction', 'drift', 'retarget', 'unresolved-finding', 'inherited-work', 'unverified'];

const grouped = new Map();
for (const finding of result.reconciliation) {
  if (!grouped.has(finding.severity)) grouped.set(finding.severity, []);
  grouped.get(finding.severity).push(finding);
}

out();
out('--- reconciliation (evidence vs dashboard) ---');
if (result.reconciliation.length === 0) {
  out('No drift detected between the dashboard and the available evidence.');
  if (!githubAvailable && prNumbers.length > 0) {
    out('NOTE: no GitHub state was readable, so PR-level drift was not checked.');
  }
} else {
  const severities = [
    ...SEVERITY_ORDER.filter((severity) => grouped.has(severity)),
    ...[...grouped.keys()].filter((severity) => !SEVERITY_ORDER.includes(severity)),
  ];
  for (const severity of severities) {
    out(`[${severity}]`);
    for (const finding of grouped.get(severity)) {
      out(`  - ${finding.message}`);
      if (finding.action) out(`    -> ${finding.action}`);
    }
  }
}

out();
out('--- git evidence ---');
out(status);
out();
out(`unstaged: ${unstaged || '(clean)'}`);
out(`staged:   ${staged || '(none)'}`);
out();
out(`--- recent history ---\n${log}`);

if (train.decisions) {
  out();
  out('--- train decisions (durable, needed by later PRs) ---');
  out(train.decisions);
}

if (train.checkpoint.size > 0) {
  out();
  out('--- recorded checkpoint ---');
  for (const [key, value] of train.checkpoint) out(`${key}: ${value ?? '(none)'}`);
}

out();
out('=== REQUIRED TAKEOVER SEQUENCE ===');
out('1. This snapshot, not conversation history, is the input. Treat a compaction as a restart.');
out('2. Authority order: Git/commit graph, then canonical repository policy and the tracked exec plan, then GitHub PR and final-head CI state, then this dashboard.');
out('3. Inspect inherited working-tree changes before editing. Never reset, stash, clean, discard, or force-push.');
out('4. Resolve every reconciliation finding above deliberately. Do not rewrite a source-of-truth fact to make the dashboard agree.');
out('5. Read the tracked exec plan for the current PR before continuing.');
out('6. Continue exactly the "Next legitimate action" for the CURRENT PR.');
out('7. Checkpoint the dashboard after every objectively verified transition, and before compacting or stopping.');
out('8. Never merge, enable auto-merge, or start a PR outside the approved execution window.');
if (!result.progression.allowed) {
  out(`9. ${result.progression.message} Do not begin another roadmap PR; report to the human instead.`);
  for (const reason of result.progression.reasons) out(`   - ${reason}`);
} else {
  out(`9. ${result.progression.message}`);
  out(
    '   A PLANNED slot may start when its own dependencies are verified by evidence and its task is approved — see "planned slot eligibility" above.',
  );
  out(
    '   An independent or sibling slot may start while another PR is CI_PENDING; a slot that DEPENDS on the pending PR may not.',
  );
}
