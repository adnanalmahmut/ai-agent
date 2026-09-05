#!/usr/bin/env node
/**
 * Read-only resume snapshot.
 *
 * A compaction is a process restart, not continuity of memory. This prints the
 * evidence a fresh agent needs to take over — Git first, then GitHub if `gh` is
 * available — and nothing else. It owns no state: every fact below comes from a
 * command that only reads.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/** Inspection only. Every call here reads state; none of them change it. */
function run(command, args, fallback = '') {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return fallback;
  }
}

const root = run('git', ['rev-parse', '--show-toplevel']);
if (!root) {
  console.error('agents:resume must be run inside a Git repository');
  process.exit(2);
}
process.chdir(root);

const out = (line = '') => console.log(line);

// ---------------------------------------------------------------------------
// Git evidence
// ---------------------------------------------------------------------------

const branch = run('git', ['branch', '--show-current'], '(detached)');
const head = run('git', ['rev-parse', 'HEAD'], '(unknown)');
const status = run('git', ['status', '--short', '--branch'], '(status unavailable)');
const log = run('git', ['log', '--oneline', '--decorate', '--graph', '-n', '12'], '(log unavailable)');
const mainSha = run('git', ['rev-parse', 'origin/main'], run('git', ['rev-parse', 'main'], '(unavailable)'));
const upstream = run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
const tracking = upstream
  ? run('git', ['rev-list', '--left-right', '--count', `${upstream}...HEAD`]).replace(/\s+/, ' behind / ') + ' ahead'
  : '(no upstream)';

out();
out('=== AGENT RESUME SNAPSHOT ===');
out(`Repository:  ${root}`);
out(`Branch:      ${branch}`);
out(`HEAD:        ${head}`);
out(`origin/main: ${mainSha}`);
out(`Upstream:    ${upstream || '(none)'}  ${upstream ? tracking : ''}`);

out();
out('--- git status ---');
out(status);

out();
out('--- recent history ---');
out(log);

// ---------------------------------------------------------------------------
// GitHub evidence
//
// GitHub is the authority on pull-request and CI state. This asks it directly
// rather than keeping a second copy of what it already knows. A PR is green only
// when the checks for its exact current head SHA are green.
// ---------------------------------------------------------------------------

const PR_FIELDS =
  'number,title,state,isDraft,baseRefName,headRefName,headRefOid,url,mergeable,mergeStateStatus,statusCheckRollup';

/** Rolls the per-check array up to one word. Unknown beats an optimistic guess. */
function rollup(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return 'none reported';
  const verdicts = checks.map((check) => String(check.conclusion || check.status || ''));
  if (verdicts.some((verdict) => /FAILURE|TIMED_OUT|CANCELLED|ACTION_REQUIRED|ERROR/i.test(verdict))) return 'FAILURE';
  if (verdicts.some((verdict) => /PENDING|QUEUED|IN_PROGRESS|WAITING|REQUESTED/i.test(verdict))) return 'PENDING';
  if (verdicts.every((verdict) => /SUCCESS|NEUTRAL|SKIPPED/i.test(verdict))) return 'SUCCESS';
  return 'unknown';
}

out();
out('--- github ---');
const raw = branch === '(detached)' ? '' : run('gh', ['pr', 'view', branch, '--json', PR_FIELDS]);
let pr = null;
if (raw) {
  try {
    pr = JSON.parse(raw);
  } catch {
    pr = null;
  }
}

if (pr) {
  out(`PR:          #${pr.number} ${pr.title ?? ''}`);
  out(`State:       ${pr.state}${pr.isDraft ? ' (draft)' : ''}`);
  out(`Base:        ${pr.baseRefName}   Head: ${pr.headRefName}`);
  out(`Head SHA:    ${pr.headRefOid}${pr.headRefOid === head ? '' : '   (LOCAL HEAD DIFFERS — push before trusting CI)'}`);
  out(`Mergeable:   ${pr.mergeable ?? '?'} / ${pr.mergeStateStatus ?? '?'}`);
  out(`Checks:      ${rollup(pr.statusCheckRollup)}  (for head SHA above)`);
  out(`URL:         ${pr.url}`);
} else {
  out('GitHub evidence unavailable: no PR found for this branch, or `gh` is');
  out('missing/unauthenticated. Local Git evidence above still applies.');
  out('Check manually with: gh pr view --web');
}

// ---------------------------------------------------------------------------
// Optional local checkpoint
//
// A plain note, not a schema. It is never authoritative over Git or GitHub, and
// nothing here parses it.
// ---------------------------------------------------------------------------

const notePath = process.env.AGENTS_NOTE ?? 'TODO.md';
if (existsSync(notePath)) {
  out();
  out(`--- local checkpoint (${notePath}, plain note, not authoritative) ---`);
  out(readFileSync(notePath, 'utf8').trimEnd());
}

out();
out('Authority order: Git, then GitHub PR and final-head CI, then repository docs.');
out('Any local note is a reminder, never a source of truth. Prepare work; a human merges.');
