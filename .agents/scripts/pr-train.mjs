/**
 * Bounded PR-train state model.
 *
 * This module is deliberately pure: it takes the dashboard text and an evidence
 * object, and returns a model plus findings. Nothing here shells out, reads the
 * filesystem, or talks to GitHub. That separation is the point — the state
 * machine and the reconciliation rules are the part that must be provably
 * correct, and they are testable only if they do not need a real repository.
 *
 * `resume-task.mjs` is the integration boundary that gathers real Git/GitHub
 * evidence and feeds it in.
 *
 * The model exists to answer one question after a compaction or restart: what
 * is the next legitimate action? Conversation memory is never an input.
 */

/** Configured train size for product/domain work. */
export const DEFAULT_TRAIN_LIMIT = 3;

/**
 * The largest train the workflow supports at all. A dashboard asking for more
 * than this is a malformed dashboard, not a bigger train: past four open PRs a
 * solo reviewer cannot hold the dependency structure, and the harness would be
 * pretending to a capability it does not have.
 */
export const TRAIN_LIMIT_CEILING = 4;

export const TRAIN_LIMIT_REACHED = 'TRAIN LIMIT REACHED — HUMAN CHECKPOINT REQUIRED';

/**
 * Ordered lifecycle. Order is what makes transitions checkable: a slot may
 * advance to any later state, but a claim must be supported by the fields that
 * state requires (see `stateContradictions`). BLOCKED is an off-ramp reachable
 * from anywhere and is not part of the ordering.
 */
export const PR_STATES = [
  'PLANNED',
  'ACTIVE',
  'IMPLEMENTED',
  'LOCAL_VERIFIED',
  'PR_OPEN',
  'CI_PENDING',
  'CI_GREEN',
  'REVIEW_FINDINGS',
  'READY_FOR_HUMAN',
  'MERGED',
];

export const BLOCKED = 'BLOCKED';

/** States from which a slot no longer occupies a train slot. */
const RELEASED_STATES = new Set(['PLANNED', 'MERGED']);

/** States that assert a pull request exists on GitHub. */
const REQUIRES_PR_NUMBER = new Set([
  'PR_OPEN',
  'CI_PENDING',
  'CI_GREEN',
  'REVIEW_FINDINGS',
  'READY_FOR_HUMAN',
  'MERGED',
]);

/**
 * States whose claim of verification must be backed by evidence before it may be
 * relied on by a *new* slot. Continuing existing work uses the recorded state;
 * authorizing new work does not.
 */
const VERIFIED_STATES = new Set(['CI_GREEN', 'REVIEW_FINDINGS', 'READY_FOR_HUMAN', 'MERGED']);

/** States that assert a specific commit was verified. */
const REQUIRES_HEAD_SHA = new Set(['CI_GREEN', 'REVIEW_FINDINGS', 'READY_FOR_HUMAN', 'MERGED']);

export const DEPENDENCY_TYPES = new Set(['independent', 'stacked']);

const TRAIN_HEADING = '# ACTIVE PR TRAIN';
const DECISIONS_HEADING = '# TRAIN DECISIONS';
const FINDINGS_HEADING = '# UNRESOLVED FINDINGS';
const CHECKPOINT_HEADING = '# CURRENT CHECKPOINT';

const CHECKLIST_STEPS = [
  'discovery',
  'design',
  'implementation',
  'narrow verification',
  'aggregate verification',
  'self-review',
  'specialist review',
  'repair',
  'final-head CI',
  'human handoff',
];

/**
 * Reads `Key: value` lines out of a block. Values are trimmed and the sentinels
 * that mean "deliberately empty" collapse to null, so a caller never has to
 * distinguish `none` from `-` from absent.
 */
function fields(block) {
  const values = new Map();
  for (const line of block.split('\n')) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9 /_-]*):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    // First occurrence wins, so a later prose mention cannot silently redefine
    // a recorded fact.
    if (values.has(key)) continue;
    const raw = match[2].trim();
    values.set(key, /^(none|n\/a|-|—|tbd)$/i.test(raw) || raw === '' ? null : raw);
  }
  return values;
}

/** Extracts the text of a top-level `# HEADING` section. */
function section(text, heading) {
  const start = text.indexOf(`${heading}\n`);
  if (start === -1) return null;
  const rest = text.slice(start + heading.length + 1);
  const next = rest.search(/^# /m);
  return next === -1 ? rest : rest.slice(0, next);
}

function parseChecklist(block) {
  const items = [];
  for (const line of block.split('\n')) {
    const match = line.match(/^\s*- \[([ xX])\]\s*(.+?)\s*$/);
    if (!match) continue;
    items.push({ done: match[1].toLowerCase() === 'x', label: match[2] });
  }
  return items;
}

/**
 * `Depends on:` accepts `PR 1`, `PR1`, `1`, or a comma-separated list. Returns
 * slot numbers. A value that names nothing parseable is reported rather than
 * silently dropped — a dependency the model cannot see is worse than none.
 */
function parseDependsOn(raw, errors, label) {
  if (!raw) return [];
  const slots = [];
  for (const part of raw.split(',')) {
    const piece = part.trim();
    if (!piece) continue;
    const match = piece.match(/^(?:PR\s*)?#?(\d+)$/i);
    if (!match) {
      errors.push(`${label}: cannot parse dependency "${piece}"; use "PR <slot>" or "none"`);
      continue;
    }
    slots.push(Number(match[1]));
  }
  return [...new Set(slots)].sort((a, b) => a - b);
}

function parseSlotHeading(heading, errors) {
  // "## PR 2 — AUD-01" or "## PR 2 - AUD-01"
  const match = heading.match(/^PR\s*(\d+)\s*(?:[—–-]\s*(.+))?$/i);
  if (!match) {
    errors.push(`malformed PR slot heading: "${heading}"; expected "## PR <slot> — <task id>"`);
    return null;
  }
  return { slot: Number(match[1]), taskId: match[2]?.trim() ?? null };
}

/**
 * Parses the dashboard into a train model.
 *
 * Fails closed: anything ambiguous becomes an error and `train` is returned with
 * `valid: false`. Resume must never guess when the recorded state does not make
 * sense, because guessing is exactly how a compacted session invents progress
 * it never made.
 */
export function parseTrain(text) {
  const errors = [];
  const warnings = [];

  if (typeof text !== 'string' || text.trim() === '') {
    return { valid: false, errors: ['dashboard is empty'], warnings, train: null };
  }

  const trainSection = section(text, TRAIN_HEADING);
  if (trainSection === null) {
    // The single-PR dashboard is a recognizable predecessor, so say so instead
    // of reporting a generic parse failure.
    const legacy = text.includes('# ACTIVE PR\n');
    errors.push(
      legacy
        ? `dashboard uses the superseded single-PR "# ACTIVE PR" section; migrate it to "${TRAIN_HEADING}" (see docs/agent-harness.md)`
        : `dashboard has no "${TRAIN_HEADING}" section`,
    );
    return { valid: false, errors, warnings, train: null, needsMigration: legacy };
  }

  const header = fields(trainSection.split(/^## /m)[0]);

  const configuredRaw = header.get('configured max open prs');
  let configuredLimit = DEFAULT_TRAIN_LIMIT;
  if (configuredRaw === null || configuredRaw === undefined) {
    warnings.push(
      `train does not record "Configured max open PRs"; assuming the default of ${DEFAULT_TRAIN_LIMIT}`,
    );
  } else if (!/^\d+$/.test(configuredRaw)) {
    errors.push(`"Configured max open PRs" must be an integer, got "${configuredRaw}"`);
  } else {
    configuredLimit = Number(configuredRaw);
    if (configuredLimit < 1) {
      errors.push('"Configured max open PRs" must be at least 1');
    } else if (configuredLimit > TRAIN_LIMIT_CEILING) {
      errors.push(
        `"Configured max open PRs" is ${configuredLimit}, above the supported ceiling of ${TRAIN_LIMIT_CEILING}`,
      );
    }
  }

  const slots = [];
  const blocks = trainSection.split(/^## /m).slice(1);
  for (const block of blocks) {
    const newline = block.indexOf('\n');
    const heading = (newline === -1 ? block : block.slice(0, newline)).trim();
    const body = newline === -1 ? '' : block.slice(newline + 1);
    const parsedHeading = parseSlotHeading(heading, errors);
    if (!parsedHeading) continue;

    const f = fields(body);
    const label = `PR ${parsedHeading.slot}`;
    const state = (f.get('state') ?? '').toUpperCase() || null;
    if (!state) {
      errors.push(`${label}: missing "State"`);
    } else if (state !== BLOCKED && !PR_STATES.includes(state)) {
      errors.push(`${label}: unknown state "${state}"`);
    }

    const dependencyTypeRaw = (f.get('dependency type') ?? '').toLowerCase() || null;
    if (dependencyTypeRaw && !DEPENDENCY_TYPES.has(dependencyTypeRaw)) {
      errors.push(
        `${label}: "Dependency type" must be one of ${[...DEPENDENCY_TYPES].join(', ')}, got "${dependencyTypeRaw}"`,
      );
    }

    const prNumberRaw = f.get('pr number');
    let prNumber = null;
    if (prNumberRaw !== null && prNumberRaw !== undefined) {
      const match = prNumberRaw.match(/^#?(\d+)$/);
      if (!match) errors.push(`${label}: cannot parse "PR number" value "${prNumberRaw}"`);
      else prNumber = Number(match[1]);
    }

    slots.push({
      slot: parsedHeading.slot,
      taskId: parsedHeading.taskId ?? f.get('task') ?? null,
      task: f.get('task') ?? null,
      branch: f.get('branch') ?? null,
      base: f.get('base') ?? null,
      baseSha: f.get('base sha') ?? f.get('base sha if relevant') ?? null,
      prNumber,
      prUrl: f.get('pr url') ?? null,
      headSha: f.get('head sha') ?? null,
      state,
      dependsOn: parseDependsOn(f.get('depends on'), errors, label),
      dependencyType: dependencyTypeRaw,
      dependencyReason: f.get('dependency reason') ?? null,
      mergeOrderConstraint: f.get('merge order constraint') ?? null,
      lastVerified: f.get('last verified') ?? null,
      nextAction: f.get('next exact action') ?? null,
      checklist: parseChecklist(body),
    });
  }

  if (slots.length === 0) errors.push('train records no PR slots');

  const seen = new Set();
  for (const slot of slots) {
    if (seen.has(slot.slot)) errors.push(`duplicate PR slot ${slot.slot}`);
    seen.add(slot.slot);
  }
  slots.sort((a, b) => a.slot - b.slot);

  const currentRaw = header.get('current pr');
  let currentSlot = null;
  if (currentRaw === null || currentRaw === undefined) {
    warnings.push('train does not record "Current PR"');
  } else {
    const match = currentRaw.match(/^(?:PR\s*)?#?(\d+)$/i);
    if (!match) errors.push(`cannot parse "Current PR" value "${currentRaw}"`);
    else currentSlot = Number(match[1]);
  }

  const train = {
    id: header.get('train') ?? null,
    state: header.get('train state') ?? null,
    anchorMainSha: header.get('anchor main sha') ?? null,
    configuredLimit,
    ceiling: TRAIN_LIMIT_CEILING,
    declaredMergeOrder: header.get('merge order if constrained') ?? null,
    currentSlot,
    slots,
    decisions: (section(text, DECISIONS_HEADING) ?? '').trim(),
    findings: parseFindings(section(text, FINDINGS_HEADING)),
    checkpoint: fields(section(text, CHECKPOINT_HEADING) ?? ''),
  };

  errors.push(...structuralContradictions(train));
  warnings.push(...structuralWarnings(train));

  return { valid: errors.length === 0, errors, warnings, train };
}

/**
 * Findings are read as list items so they survive as discrete units. A finding
 * that only exists as a paragraph tends to be summarized away by the next
 * compaction.
 */
function parseFindings(block) {
  if (!block) return [];
  const findings = [];
  for (const line of block.split('\n')) {
    const match = line.match(/^\s*- (?:\[([ xX])\]\s*)?(.+?)\s*$/);
    if (match) {
      findings.push({ resolved: match[1]?.toLowerCase() === 'x', text: match[2] });
      continue;
    }
    // Continuation of the previous item. Without this a wrapped finding is
    // reported as its first line only, which is how a finding turns into a
    // fragment nobody can act on.
    const continuation = line.match(/^\s+(\S.*?)\s*$/);
    if (continuation && findings.length > 0) {
      findings[findings.length - 1].text += ` ${continuation[1]}`;
    }
  }
  return findings;
}

/**
 * Base/dependency/type invariants a slot must satisfy to *be* ACTIVE.
 *
 * Shared by structural parsing, applied to a slot already past PLANNED, and by
 * `slotEligibility`, applied hypothetically to a PLANNED slot considering the
 * transition to ACTIVE. One function means "eligible" and "structurally valid
 * once active" cannot drift apart: a PLANNED slot must clear exactly the shape
 * its non-PLANNED neighbors are already held to, no more and no less.
 *
 * State itself is deliberately not consulted here — that is what makes the
 * function safe to run against a PLANNED slot as a hypothetical.
 */
function activationShapeErrors(slot, bySlot) {
  const label = `PR ${slot.slot}`;
  const errors = [];

  // Dependency and base must agree. This is the guard that stops a sibling
  // from silently becoming a link in a deep stack: the base branch is the
  // only physical evidence of a dependency, so the recorded dependency has to
  // match it in both directions.
  if (slot.dependencyType === 'independent' && slot.dependsOn.length > 0) {
    errors.push(`${label}: dependency type "independent" contradicts "Depends on: PR ${slot.dependsOn.join(', PR ')}"`);
  }
  if (slot.dependencyType === 'stacked' && slot.dependsOn.length === 0) {
    errors.push(`${label}: dependency type "stacked" requires a "Depends on" slot`);
  }
  if (slot.dependencyType !== 'independent' && slot.dependencyType !== 'stacked') {
    errors.push(`${label}: "Dependency type" must be independent or stacked to activate, got "${slot.dependencyType ?? '(none)'}"`);
  }

  for (const dependency of slot.dependsOn) {
    const parent = bySlot.get(dependency);
    if (!parent) {
      errors.push(`${label}: depends on PR ${dependency}, which is not a slot in this train`);
      continue;
    }
    if (dependency === slot.slot) errors.push(`${label}: depends on itself`);
    if (!slot.base) {
      errors.push(`${label}: depends on PR ${dependency} but records no "Base"; base must equal the dependency's branch`);
      // A stacked PR's base must be its dependency's branch. If the base says
      // `main`, the dependency is imaginary and the merge order it implies is
      // unenforceable.
    } else if (parent.branch && slot.base !== parent.branch && parent.state !== 'MERGED') {
      errors.push(
        `${label}: depends on PR ${dependency} but its base is "${slot.base}", not "${parent.branch}"; either rebase onto the dependency or record it as independent`,
      );
    }
  }

  if (slot.dependsOn.length === 0) {
    if (!slot.base) {
      errors.push(`${label}: is independent but records no "Base"; an independent slot's base must be "main"`);
    } else if (slot.base !== 'main') {
      errors.push(
        `${label}: base is "${slot.base}" rather than main but no dependency is recorded; an undeclared stack has no reviewable merge order`,
      );
    }
  }

  return errors;
}

/** Contradictions that make the recorded train impossible rather than merely odd. */
function structuralContradictions(train) {
  const errors = [];
  const bySlot = new Map(train.slots.map((slot) => [slot.slot, slot]));

  for (const slot of train.slots) {
    const label = `PR ${slot.slot}`;

    if (REQUIRES_PR_NUMBER.has(slot.state) && slot.prNumber === null) {
      errors.push(`${label}: state ${slot.state} asserts an open pull request but no "PR number" is recorded`);
    }
    if (REQUIRES_HEAD_SHA.has(slot.state) && !slot.headSha) {
      errors.push(`${label}: state ${slot.state} asserts a verified commit but no "Head SHA" is recorded`);
    }
    if (slot.state && slot.state !== 'PLANNED' && !slot.branch) {
      errors.push(`${label}: state ${slot.state} requires a "Branch"`);
    }
    // PLANNED releases train capacity, so it must not be able to hide a live PR.
    // This is the same hole as a slot wrongly recorded MERGED, reached from the
    // other end of the lifecycle, and it is closed structurally rather than left
    // to the evidence gate.
    if (slot.state === 'PLANNED' && slot.prNumber !== null) {
      errors.push(
        `${label}: state PLANNED records PR #${slot.prNumber}; planned work has no pull request, and PLANNED releases train capacity`,
      );
    }

    // A PLANNED slot may stay partially specified — `slotEligibility` is where
    // its base/dependency shape is held to the same invariant before it may be
    // authorized to become ACTIVE. Applying it here too would turn "not ready
    // yet" into a parse failure for work nobody has tried to start.
    if (slot.state !== 'PLANNED') {
      errors.push(...activationShapeErrors(slot, bySlot));
    }
  }

  for (const cycle of findCycles(train.slots)) {
    errors.push(`dependency cycle: ${cycle.map((slot) => `PR ${slot}`).join(' -> ')}`);
  }

  if (train.currentSlot !== null && !bySlot.has(train.currentSlot)) {
    errors.push(`"Current PR" names PR ${train.currentSlot}, which is not a slot in this train`);
  }

  const current = train.currentSlot === null ? null : bySlot.get(train.currentSlot);
  if (current && current.state === 'MERGED') {
    errors.push(`"Current PR" is PR ${current.slot}, which is recorded as MERGED; the current slot must be live work`);
  }

  return errors;
}

function structuralWarnings(train) {
  const warnings = [];
  for (const slot of train.slots) {
    const label = `PR ${slot.slot}`;
    if (slot.dependencyType === 'stacked' && !slot.dependencyReason) {
      // Not an error, because the reason is prose and prose can be added later.
      // A warning, because "we wrote it second" is the usual unstated reason and
      // it is not a dependency.
      warnings.push(
        `${label}: stacked on PR ${slot.dependsOn.join(', PR ')} without a "Dependency reason"; stack only when a real code/data/API dependency exists`,
      );
    }
    if (!slot.dependencyType && slot.state !== 'PLANNED') {
      warnings.push(`${label}: no "Dependency type" recorded`);
    }
    if (slot.state !== 'PLANNED' && !slot.nextAction) {
      warnings.push(`${label}: no "Next exact action" recorded; takeover after a compaction would have to infer it`);
    }
    const labels = slot.checklist.map((item) => item.label.toLowerCase());
    for (const step of CHECKLIST_STEPS) {
      if (slot.state === 'PLANNED') break;
      if (!labels.some((existing) => existing.includes(step.toLowerCase()))) {
        warnings.push(`${label}: checklist does not cover "${step}"`);
      }
    }
  }
  return warnings;
}

function findCycles(slots) {
  const graph = new Map(slots.map((slot) => [slot.slot, slot.dependsOn]));
  const cycles = [];
  const state = new Map();

  function visit(node, path) {
    if (state.get(node) === 'done') return;
    if (state.get(node) === 'open') {
      cycles.push([...path.slice(path.indexOf(node)), node]);
      return;
    }
    state.set(node, 'open');
    for (const next of graph.get(node) ?? []) {
      if (!graph.has(next)) continue;
      visit(next, [...path, next]);
    }
    state.set(node, 'done');
  }

  for (const slot of slots) visit(slot.slot, [slot.slot]);
  return cycles;
}

/**
 * Slots that currently occupy the train. PLANNED work has not started and
 * MERGED work has left, so neither consumes capacity.
 */
export function occupiedSlots(train) {
  return train.slots.filter((slot) => !RELEASED_STATES.has(slot.state));
}

/**
 * The train-limit decision. Returns `allowed: false` when another roadmap PR
 * must not be started, and a message the resume output prints verbatim.
 */
export function trainLimitStatus(train) {
  const occupied = occupiedSlots(train);
  const limit = Math.min(train.configuredLimit, TRAIN_LIMIT_CEILING);

  if (train.configuredLimit > TRAIN_LIMIT_CEILING) {
    return {
      allowed: false,
      occupied: occupied.length,
      limit,
      reason: `configured limit ${train.configuredLimit} exceeds the supported ceiling ${TRAIN_LIMIT_CEILING}`,
      message: `${TRAIN_LIMIT_REACHED} (configured limit ${train.configuredLimit} exceeds the supported ceiling of ${TRAIN_LIMIT_CEILING})`,
    };
  }

  if (occupied.length >= limit) {
    return {
      allowed: false,
      occupied: occupied.length,
      limit,
      reason: 'train is full',
      message: `${TRAIN_LIMIT_REACHED} (${occupied.length} of ${limit} slots occupied). Do not begin another roadmap PR.`,
    };
  }

  return {
    allowed: true,
    occupied: occupied.length,
    limit,
    reason: 'capacity available',
    message: `Train has ${limit - occupied.length} free slot(s) of ${limit}.`,
  };
}

/**
 * Two slots are siblings when they depend on exactly the same thing and not on
 * each other. Derived rather than declared, so the dashboard cannot claim a
 * sibling relationship that the recorded dependencies contradict.
 */
export function siblingGroups(train) {
  const groups = new Map();
  for (const slot of train.slots) {
    const key = slot.dependsOn.length === 0 ? 'main' : slot.dependsOn.join(',');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(slot.slot);
  }
  return [...groups.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([key, members]) => ({ sharedDependency: key, members }));
}

/**
 * Resolves the current slot and its next action.
 *
 * `Current PR` is authoritative when it names a live slot, because the agent
 * that wrote it knew something the file cannot re-derive. When it is absent, the
 * lowest-numbered live slot is used, which matches merge order.
 */
export function resolveCurrent(train, evidence = {}) {
  const bySlot = new Map(train.slots.map((slot) => [slot.slot, slot]));
  const declared = train.currentSlot === null ? null : bySlot.get(train.currentSlot);

  let current = declared && declared.state !== 'MERGED' ? declared : null;
  let inferred = false;
  if (!current) {
    current = occupiedSlots(train).sort((a, b) => a.slot - b.slot)[0] ?? null;
    inferred = current !== null;
  }

  if (!current) {
    return { current: null, inferred: false, nextAction: 'No live PR slot. The train is complete; await human merge or a new checkpoint.' };
  }

  const blocked = blockingReason(train, current, evidence);
  const unchecked = current.checklist.find((item) => !item.done);
  const nextAction =
    blocked ??
    current.nextAction ??
    (unchecked ? `Continue PR ${current.slot}: ${unchecked.label}` : `PR ${current.slot} checklist is complete; record the human handoff state`);

  return { current, inferred, nextAction, blocked: blocked !== null, unchecked: unchecked ?? null };
}

/**
 * Whether live evidence, where any was fetched for this PR, contradicts a
 * claimed verification. Absence of evidence is a different question --
 * answered by `isVerifiedByEvidence` for gating *new* work -- and is not a
 * contradiction here: losing GitHub access must not strand work already in
 * flight. This only fires when something was actually read back and disagrees.
 */
function contradictsVerification(actual) {
  if (!actual) return false;
  if (actual.state === 'MERGED') return false;
  return actual.checks !== 'SUCCESS';
}

/**
 * A dependency that is not itself verified blocks *dependent* work only. A
 * sibling may proceed while an ancestor's CI is still running, because it builds
 * on the same ancestor commit and not on the unverified change.
 *
 * The recorded state is a claim, and live evidence outranks it in both
 * directions here: a parent recorded CI_GREEN whose live checks have since
 * regressed to FAILURE, PENDING, or an unreadable rollup no longer supports a
 * dependent's continuation, even though the dashboard has not caught up yet.
 */
function blockingReason(train, slot, evidence = {}) {
  if (slot.state === BLOCKED) {
    return `PR ${slot.slot} is BLOCKED. Resolve the recorded blocker before continuing.`;
  }
  const bySlot = new Map(train.slots.map((entry) => [entry.slot, entry]));
  const prs = evidence.prs ?? {};
  for (const dependency of slot.dependsOn) {
    const parent = bySlot.get(dependency);
    if (!parent) continue;
    const recordedVerified = VERIFIED_STATES.has(parent.state);
    const actual = parent.prNumber === null ? null : (prs[parent.prNumber] ?? prs[String(parent.prNumber)]);
    if (!recordedVerified || contradictsVerification(actual)) {
      const liveDetail = actual ? ` (live checks: ${actual.checks ?? 'unknown'})` : '';
      return `PR ${slot.slot} depends on PR ${parent.slot}, which is ${parent.state}${liveDetail}. Dependent work must not build on an unverified change; finish PR ${parent.slot} to CI_GREEN first.`;
    }
  }
  return null;
}

/**
 * Reconciles the recorded train against real evidence.
 *
 * Returns findings only. Nothing here mutates the model: a dashboard that
 * disagrees with Git or GitHub is information, and silently rewriting it to
 * agree would destroy the only signal that something went wrong.
 *
 * `evidence` shape:
 *   { mainSha, branch, head, dirtyPaths: [], prs: { [number]: {
 *       state, baseRefName, headRefName, headSha, mergeStateStatus, checks } } }
 */
export function reconcile(train, evidence = {}) {
  const findings = [];
  const add = (severity, message, action = null) => findings.push({ severity, message, action });

  if (train.anchorMainSha && evidence.mainSha && !shaMatches(train.anchorMainSha, evidence.mainSha)) {
    add(
      'drift',
      `anchor main SHA is recorded as ${train.anchorMainSha} but main is ${short(evidence.mainSha)}`,
      'main advanced since the train was anchored; confirm each base is still correct before continuing',
    );
  }

  const { current } = resolveCurrent(train, evidence);
  if (current && current.branch && evidence.branch && current.branch !== evidence.branch) {
    add(
      'drift',
      `current PR ${current.slot} records branch "${current.branch}" but the worktree is on "${evidence.branch}"`,
      'check out the recorded branch or correct the dashboard after establishing which is right',
    );
  }

  if (Array.isArray(evidence.dirtyPaths) && evidence.dirtyPaths.length > 0) {
    add(
      'inherited-work',
      `uncommitted changes in ${evidence.dirtyPaths.length} path(s): ${evidence.dirtyPaths.join(', ')}`,
      'inspect before editing; never reset, stash, clean, or discard inherited work',
    );
  }

  const prs = evidence.prs ?? {};
  for (const slot of train.slots) {
    if (slot.prNumber === null) continue;
    const actual = prs[slot.prNumber] ?? prs[String(slot.prNumber)];
    if (!actual) {
      add('unverified', `PR ${slot.slot} records #${slot.prNumber} but no GitHub state was available for it`, 'confirm the PR exists before trusting its recorded state');
      continue;
    }

    if (actual.state === 'MERGED' && slot.state !== 'MERGED') {
      add(
        'drift',
        `PR ${slot.slot} (#${slot.prNumber}) is MERGED on GitHub but recorded as ${slot.state}`,
        'GitHub wins: record the merge, then reconcile dependent bases',
      );
    }
    // The inverse direction, which the first version of this missed entirely. It
    // is the more dangerous one: a slot wrongly recorded MERGED releases train
    // capacity, so a stale dashboard could authorize a PR beyond the limit.
    if (slot.state === 'MERGED' && actual.state !== 'MERGED') {
      add(
        'contradiction',
        `PR ${slot.slot} (#${slot.prNumber}) is recorded MERGED but GitHub reports ${actual.state}; the slot is still live and still occupies the train`,
        'GitHub wins in this direction too: correct the recorded state before treating the slot as released',
      );
    }
    if (actual.state === 'CLOSED' && slot.state !== 'MERGED' && slot.state !== BLOCKED) {
      add('drift', `PR ${slot.slot} (#${slot.prNumber}) is CLOSED on GitHub but recorded as ${slot.state}`, 'establish why it was closed before continuing');
    }
    if (slot.headSha && actual.headSha && !shaMatches(slot.headSha, actual.headSha)) {
      add(
        'drift',
        `PR ${slot.slot} records head ${slot.headSha} but #${slot.prNumber} head is ${short(actual.headSha)}`,
        'any verification recorded against the old head no longer applies to the final head',
      );
    }
    if (slot.base && actual.baseRefName && slot.base !== actual.baseRefName) {
      add(
        'drift',
        `PR ${slot.slot} records base "${slot.base}" but #${slot.prNumber} targets "${actual.baseRefName}"`,
        'correct the dashboard or retarget the PR deliberately; do not force-push to make them agree',
      );
    }
    if (slot.branch && actual.headRefName && slot.branch !== actual.headRefName) {
      add('drift', `PR ${slot.slot} records branch "${slot.branch}" but #${slot.prNumber} head branch is "${actual.headRefName}"`, null);
    }
    // A green claim must never survive contrary evidence — and must not survive
    // *absent* evidence either. The earlier `actual.checks &&` short-circuit let
    // an unknown or null rollup pass as though it were success, which is exactly
    // the case where nothing is known.
    if (slot.state === 'CI_GREEN' || slot.state === 'READY_FOR_HUMAN') {
      if (actual.state === 'MERGED') {
        // Already handled as a merge drift above; a merged PR needs no rollup.
      } else if (!actual.checks) {
        add(
          'unverified-claim',
          `PR ${slot.slot} is recorded as ${slot.state} but #${slot.prNumber} reports no readable check state`,
          'an unknown rollup is not a pass: re-establish final-head CI before treating this as verified or handing it off',
        );
      } else if (actual.checks !== 'SUCCESS') {
        add(
          'contradiction',
          `PR ${slot.slot} is recorded as ${slot.state} but #${slot.prNumber} checks are ${actual.checks}`,
          'demote to CI_PENDING or REVIEW_FINDINGS and record an unresolved finding; CI evidence outranks the dashboard',
        );
      }
    }
  }

  // An ancestor merging is the normal event that invalidates a stacked base.
  const bySlot = new Map(train.slots.map((slot) => [slot.slot, slot]));
  for (const slot of train.slots) {
    if (slot.state === 'MERGED') continue;
    for (const dependency of slot.dependsOn) {
      const parent = bySlot.get(dependency);
      if (!parent) continue;
      const parentActual = parent.prNumber === null ? null : (prs[parent.prNumber] ?? prs[String(parent.prNumber)]);
      const parentMerged = parent.state === 'MERGED' || parentActual?.state === 'MERGED';
      if (!parentMerged) continue;
      add(
        'retarget',
        `PR ${slot.slot} depends on PR ${parent.slot}, which is merged; its base "${slot.base ?? '(unrecorded)'}" needs human-safe reconciliation to main`,
        'ask the human to retarget or merge main forward; do not force-push history to achieve it',
      );
    }
  }

  for (const finding of train.findings.filter((entry) => !entry.resolved)) {
    add('unresolved-finding', finding.text, 'must be resolved or explicitly carried before human handoff');
  }

  return findings;
}

function short(sha) {
  return typeof sha === 'string' ? sha.slice(0, 12) : String(sha);
}

/** Compares SHAs by common prefix, so a short dashboard SHA matches a full one. */
function shaMatches(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const length = Math.min(a.length, b.length, 40);
  if (length < 7) return false;
  return a.slice(0, length).toLowerCase() === b.slice(0, length).toLowerCase();
}

/**
 * Parses `git status --porcelain -z` into accurate paths.
 *
 * Pure so it can be tested against a real fixture. `-z` does not quote paths,
 * which is why it is used, but a rename or copy emits **two** records: `R  <new>`
 * followed by a bare `<old>` with no status prefix. Slicing three characters off
 * every record therefore truncated the old path of every rename by three
 * characters — silently, in the one report whose whole job is to stop inherited
 * work being lost.
 */
export function parsePorcelainZ(raw) {
  if (typeof raw !== 'string' || raw === '') return [];
  const records = raw.split('\0').filter((record) => record !== '');
  const paths = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    // "XY " then the path. A bare continuation record has no such prefix, but a
    // well-formed stream only produces one immediately after an R/C entry, which
    // is consumed below.
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (!path) continue;

    if (status.includes('R') || status.includes('C')) {
      const original = records[index + 1];
      if (original !== undefined) {
        index += 1;
        paths.push(`${original} -> ${path}`);
        continue;
      }
    }
    paths.push(path);
  }

  return paths;
}

/**
 * Reads the approved execution window.
 *
 * Deliberately narrow: `## [APPROVED] <task id> — title` plus a checked
 * `**Approved to start:** [x]` inside that block. Anything else — `[DELIVERED]`,
 * an unchecked box, a roadmap entry — is not approval. This is a lookup table,
 * not a planner.
 */
export function parseApprovedWindow(text) {
  const approvals = new Map();
  const block = section(text, '# APPROVED EXECUTION WINDOW');
  if (block === null) return approvals;

  for (const entry of block.split(/^## /m).slice(1)) {
    const heading = entry.split('\n', 1)[0];
    const match = heading.match(/^\[APPROVED\]\s*([A-Za-z][A-Za-z0-9-]*)/);
    if (!match) continue;
    const checked = /^\s*\*\*Approved to start:\*\*\s*\[x\]/im.test(entry);
    approvals.set(match[1].toUpperCase(), checked);
  }
  return approvals;
}

/**
 * Whether a slot's recorded verification is actually backed by evidence.
 *
 * A recorded state is a claim. This is the only function allowed to answer "is
 * it true?", and it answers no when it cannot tell — absent evidence is not
 * agreement.
 */
export function isVerifiedByEvidence(slot, actual) {
  if (slot.state === 'MERGED') return actual?.state === 'MERGED';
  if (!VERIFIED_STATES.has(slot.state)) return false;
  if (!actual) return false;
  if (actual.state === 'MERGED') return true;
  return actual.checks === 'SUCCESS';
}

/**
 * Effective occupancy: what is *actually* still live, not what the dashboard
 * says.
 *
 * A slot is released only when the dashboard says MERGED **and** GitHub confirms
 * it. A dashboard-MERGED slot that GitHub reports OPEN, CLOSED-not-merged, or
 * cannot be read at all stays live, so a stale dashboard can never manufacture
 * capacity. This is the direction the earlier reconciliation missed: it caught
 * GitHub-merged/dashboard-open and not the inverse.
 */
export function effectiveOccupancy(train, evidence = {}) {
  const prs = evidence.prs ?? {};
  const live = [];
  const released = [];
  const gaps = [];

  for (const slot of train.slots) {
    if (slot.state === 'PLANNED') continue;

    if (slot.state !== 'MERGED') {
      live.push(slot.slot);
      continue;
    }

    if (slot.prNumber === null) {
      // MERGED with no PR number cannot be confirmed at all.
      live.push(slot.slot);
      gaps.push(`PR ${slot.slot} is recorded MERGED but records no PR number, so the merge cannot be confirmed`);
      continue;
    }

    const actual = prs[slot.prNumber] ?? prs[String(slot.prNumber)];
    if (!actual) {
      live.push(slot.slot);
      gaps.push(`PR ${slot.slot} (#${slot.prNumber}) is recorded MERGED but no GitHub state could be read to confirm it`);
      continue;
    }
    if (actual.state === 'MERGED') {
      released.push(slot.slot);
      continue;
    }
    live.push(slot.slot);
    gaps.push(
      `PR ${slot.slot} (#${slot.prNumber}) is recorded MERGED but GitHub reports ${actual.state}; the slot is still live`,
    );
  }

  return { live, released, gaps };
}

/**
 * The new-slot progression gate.
 *
 * Separate from `trainLimitStatus` on purpose. That function answers "what does
 * the dashboard record?" and stays free of integration concerns; this one
 * answers "is starting another PR authorized by live evidence?" and fails closed
 * whenever it cannot tell.
 */
export function progressionGate(train, evidence = {}) {
  const recorded = trainLimitStatus(train);
  const occupancy = effectiveOccupancy(train, evidence);
  const limit = Math.min(train.configuredLimit, TRAIN_LIMIT_CEILING);
  const reasons = [];
  const prs = evidence.prs ?? {};

  if (train.configuredLimit > TRAIN_LIMIT_CEILING) {
    reasons.push(`configured limit ${train.configuredLimit} exceeds the supported ceiling of ${TRAIN_LIMIT_CEILING}`);
  }

  if (occupancy.live.length >= limit) {
    reasons.push(`${occupancy.live.length} of ${limit} slots are live by evidence`);
  }

  reasons.push(...occupancy.gaps);

  // Any recorded PR whose live state is unknown makes the whole capacity
  // calculation unreliable, not just that slot's.
  for (const slot of train.slots) {
    if (slot.prNumber === null) continue;
    const actual = prs[slot.prNumber] ?? prs[String(slot.prNumber)];
    if (!actual) {
      reasons.push(`PR ${slot.slot} (#${slot.prNumber}) has no readable GitHub state, so capacity cannot be established`);
    }
  }

  // A live FAILURE anywhere in the active train outranks a dashboard that has
  // not caught up to it. The CI_PENDING sibling/independent exception assumes
  // a genuinely still-running check; a run that already failed is not merely
  // pending, whatever the dashboard still says. This does not require the
  // failure to already be recorded as an unresolved finding -- GitHub evidence
  // outranks the TODO, not the other way around.
  for (const slot of train.slots) {
    if (slot.state === 'PLANNED' || slot.state === 'MERGED') continue;
    if (slot.prNumber === null) continue;
    const actual = prs[slot.prNumber] ?? prs[String(slot.prNumber)];
    if (actual && actual.checks === 'FAILURE') {
      reasons.push(
        `PR ${slot.slot} (#${slot.prNumber}) has a live CI FAILURE; new-slot progression is blocked until it is reconciled, recorded, or repaired`,
      );
    }
  }

  for (const finding of train.findings.filter((entry) => !entry.resolved)) {
    reasons.push(`unresolved finding must be resolved or explicitly carried first: ${finding.text}`);
  }

  const unique = [...new Set(reasons)];
  return {
    allowed: unique.length === 0,
    reasons: unique,
    recordedOccupancy: recorded.occupied,
    effectiveOccupancy: occupancy.live.length,
    liveSlots: occupancy.live,
    confirmedReleased: occupancy.released,
    limit,
    message:
      unique.length === 0
        ? `NEW-SLOT PROGRESSION ALLOWED (${occupancy.live.length} of ${limit} slots live by evidence).`
        : `NEW-SLOT PROGRESSION BLOCKED (${occupancy.live.length} of ${limit} slots live by evidence).`,
  };
}

/**
 * Whether a PLANNED slot may become ACTIVE.
 *
 * This is the executable form of the CI_PENDING sibling exception. The rule is
 * about the slot's *own* dependencies and nothing else: a sibling being
 * CI_PENDING is irrelevant, because a sibling shares the ancestor's commit
 * rather than the pending change. Creation order is never consulted.
 */
export function slotEligibility(train, slot, evidence = {}, approvals = new Map()) {
  const reasons = [];

  if (slot.state !== 'PLANNED') {
    return { eligible: false, reasons: [`PR ${slot.slot} is ${slot.state}, not PLANNED`], notApplicable: true };
  }

  const bySlot = new Map(train.slots.map((entry) => [entry.slot, entry]));

  // The same invariant a non-PLANNED slot is already held to, checked here
  // against the *hypothetical* transition PLANNED -> ACTIVE: MAY START must
  // mean the slot is structurally ready to become ACTIVE, not merely that its
  // dependencies happen to be verified.
  reasons.push(...activationShapeErrors(slot, bySlot));

  const gate = progressionGate(train, evidence);
  if (!gate.allowed) reasons.push(...gate.reasons);

  const prs = evidence.prs ?? {};

  for (const dependency of slot.dependsOn) {
    const parent = bySlot.get(dependency);
    if (!parent) {
      reasons.push(`depends on PR ${dependency}, which is not in this train`);
      continue;
    }
    const actual = parent.prNumber === null ? null : (prs[parent.prNumber] ?? prs[String(parent.prNumber)]);
    if (!isVerifiedByEvidence(parent, actual)) {
      reasons.push(
        `its dependency PR ${parent.slot} is ${parent.state}${actual ? ` with checks ${actual.checks ?? 'unknown'}` : ' with no readable GitHub state'}; dependent work must not build on an unverified change`,
      );
    }
  }

  // Approval is part of the decision rather than an unenforced policy note,
  // because the window format is a fixed heading plus a checkbox.
  const taskId = (slot.taskId ?? '').toUpperCase().match(/^[A-Z][A-Z0-9-]*/)?.[0] ?? null;
  if (!taskId) {
    reasons.push('no task id could be read from the slot heading, so approval cannot be established');
  } else if (approvals.size === 0) {
    reasons.push('no "# APPROVED EXECUTION WINDOW" entries could be read, so approval cannot be established');
  } else if (!approvals.has(taskId)) {
    reasons.push(`${taskId} does not appear as [APPROVED] in the execution window`);
  } else if (approvals.get(taskId) !== true) {
    reasons.push(`${taskId} appears in the execution window but its "Approved to start" box is not checked`);
  }

  const unique = [...new Set(reasons)];
  return { eligible: unique.length === 0, reasons: unique };
}

/**
 * The dashboard-file safety contract.
 *
 * The dashboard holds operational state and must stay local. The two unsafe
 * conditions are not equally bad, so they are not treated equally:
 *
 *   - tracked by Git: it is already in the repository's history or index and the
 *     next commit will publish it. That is a refusal.
 *   - untracked but not ignored: a `git add -A` would stage it. That is a
 *     warning, because nothing is wrong yet and refusing would strand an agent
 *     whose only fault is a missing ignore rule.
 */
export function dashboardFileDecision({ exists, tracked, ignored }) {
  if (!exists) {
    return {
      ok: false,
      severity: 'refuse',
      message: 'the dashboard file is missing. Reconstruct it from the tracked exec plan and Git/GitHub state before continuing; do not invent train state from memory.',
    };
  }
  if (tracked) {
    return {
      ok: false,
      severity: 'refuse',
      message: 'the dashboard file is tracked by Git. It is a local operational dashboard, not repository state: untrack it (git rm --cached) and ignore it before continuing.',
    };
  }
  if (!ignored) {
    return {
      ok: true,
      severity: 'warn',
      message:
        'the dashboard file is not ignored. Ignore it locally, preferably through `.git/info/exclude`, and do not stage it. Stage explicit paths only, never `git add -A`. Do not edit tracked .gitignore for local-only state.',
    };
  }
  return { ok: true, severity: 'ok', message: 'dashboard file is local and ignored.' };
}

/**
 * Evidence that contradicts the current slot outranks the recorded next action.
 *
 * Without this, "GitHub wins over a stale dashboard" is only advice printed
 * below an instruction that still says "human merge". The instruction itself has
 * to change, or the authority order is decorative.
 */
/**
 * Severities that must change the instruction, not merely accompany it.
 *
 * `unverified-claim` is here because an unreadable rollup is not a pass.
 * `unverified` is here for the case that exposed the gap: with `gh` down there is
 * no rollup to read at all, only a "no GitHub state was available" finding — and
 * a slot recorded READY_FOR_HUMAN would still have printed "human merge" beneath
 * it. Absent evidence must suppress a handoff instruction exactly as
 * contradictory evidence does.
 */
const BLOCKING_SEVERITIES = new Set(['contradiction', 'drift', 'unverified-claim', 'unverified']);

export function nextActionUnderEvidence(train, current, recorded, findings) {
  if (!current) return recorded;

  const blocking = findings.filter((finding) => {
    if (!BLOCKING_SEVERITIES.has(finding.severity)) return false;
    // Train-level drift (main advanced) and any finding naming the current slot.
    return !/^PR \d+/.test(finding.message) || finding.message.startsWith(`PR ${current.slot}`);
  });

  if (blocking.length === 0) return recorded;

  return [
    `RESOLVE EVIDENCE CONFLICT FIRST for PR ${current.slot}, then re-derive the next action.`,
    ...blocking.map((finding) => `  - ${finding.message}`),
    `Recorded action, not yet valid: ${recorded}`,
  ].join('\n');
}

/** Everything a resume needs, in one call. */
export function analyze(text, evidence = {}) {
  const parsed = parseTrain(text);
  if (!parsed.valid) {
    return { ...parsed, limit: null, progression: null, eligibility: [], current: null, siblings: [], reconciliation: [] };
  }
  const resolved = resolveCurrent(parsed.train, evidence);
  const reconciliation = reconcile(parsed.train, evidence);
  const approvals = parseApprovedWindow(text);
  const progression = progressionGate(parsed.train, evidence);
  const eligibility = parsed.train.slots
    .filter((slot) => slot.state === 'PLANNED')
    .map((slot) => ({ slot: slot.slot, taskId: slot.taskId, ...slotEligibility(parsed.train, slot, evidence, approvals) }));

  return {
    ...parsed,
    // What the dashboard records, kept separate from what evidence authorizes.
    limit: trainLimitStatus(parsed.train),
    progression,
    approvals,
    eligibility,
    ...resolved,
    recordedNextAction: resolved.nextAction,
    nextAction: nextActionUnderEvidence(parsed.train, resolved.current, resolved.nextAction, reconciliation),
    siblings: siblingGroups(parsed.train),
    reconciliation,
  };
}
