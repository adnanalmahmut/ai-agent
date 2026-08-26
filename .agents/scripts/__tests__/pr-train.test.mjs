import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BLOCKED,
  DEFAULT_TRAIN_LIMIT,
  TRAIN_LIMIT_CEILING,
  TRAIN_LIMIT_REACHED,
  analyze,
  dashboardFileDecision,
  occupiedSlots,
  parseTrain,
  reconcile,
  resolveCurrent,
  siblingGroups,
  trainLimitStatus,
} from '../pr-train.mjs';

/**
 * Fixtures are built from parts so each test changes exactly one thing. A test
 * that rewrites the whole dashboard tends to pass for a reason other than the
 * one it names.
 */

const FULL_CHECKLIST = `Checklist:
- [x] discovery
- [x] design
- [x] implementation
- [x] narrow verification
- [x] aggregate verification
- [x] self-review
- [x] specialist review where required
- [x] repair
- [x] final-head CI
- [ ] human handoff`;

function slot({
  number,
  taskId = `TASK-0${number}`,
  branch = `feat/task-${number}`,
  base = 'main',
  prNumber = 100 + number,
  headSha = `head${number}0000000000000000000000000000000000`,
  state = 'CI_GREEN',
  dependsOn = 'none',
  dependencyType = 'independent',
  dependencyReason = null,
  nextAction = 'human merge',
  checklist = FULL_CHECKLIST,
}) {
  return [
    `## PR ${number} — ${taskId}`,
    '',
    `Task: ${taskId} work`,
    `Branch: ${branch}`,
    `Base: ${base}`,
    `Base SHA: 9a90e1f`,
    `PR number: ${prNumber === null ? 'none' : prNumber}`,
    `PR URL: ${prNumber === null ? 'none' : `https://github.com/o/r/pull/${prNumber}`}`,
    `Head SHA: ${headSha === null ? 'none' : headSha}`,
    `State: ${state}`,
    `Depends on: ${dependsOn}`,
    `Dependency type: ${dependencyType}`,
    ...(dependencyReason ? [`Dependency reason: ${dependencyReason}`] : []),
    `Merge order constraint: none`,
    `Last verified: 2026-08-27`,
    `Next exact action: ${nextAction}`,
    '',
    checklist,
    '',
  ].join('\n');
}

function dashboard({ limit = 3, current = 1, slots = [slot({ number: 1 })], extra = '' } = {}) {
  return [
    '# ACTIVE PR TRAIN',
    '',
    'Train: product-foundation',
    'Train state: IN_PROGRESS',
    'Anchor main SHA: 9a90e1f5befa3048a258858066d3c6bc5a822ad7',
    `Configured max open PRs: ${limit}`,
    `Current PR: ${current === null ? 'none' : current}`,
    'Merge order if constrained: none',
    '',
    ...slots,
    extra,
    '',
    '# APPROVED EXECUTION WINDOW',
    '',
    '## [APPROVED] TASK-02',
    '',
  ].join('\n');
}

// 1. Existing one-PR state migrates cleanly or fails with a precise message.
test('the superseded single-PR dashboard fails with an explicit migration message', () => {
  const legacy = ['# ACTIVE PR', '', '## [ACTIVE] OPS-03 closure', '', '- [ ] Human merge', ''].join('\n');
  const result = parseTrain(legacy);
  assert.equal(result.valid, false);
  assert.equal(result.needsMigration, true);
  assert.match(result.errors.join('\n'), /superseded single-PR/);
  assert.match(result.errors.join('\n'), /# ACTIVE PR TRAIN/);
});

test('a dashboard with no train section at all is distinguished from a migration case', () => {
  const result = parseTrain('# SOMETHING ELSE\n\nnothing here\n');
  assert.equal(result.valid, false);
  assert.ok(!result.needsMigration);
  assert.match(result.errors.join('\n'), /no "# ACTIVE PR TRAIN" section/);
});

// 2. A valid 3-PR train parses correctly.
test('a valid three-PR train parses', () => {
  const text = dashboard({
    current: 3,
    slots: [
      slot({ number: 1, state: 'READY_FOR_HUMAN' }),
      slot({
        number: 2,
        base: 'feat/task-1',
        dependsOn: 'PR 1',
        dependencyType: 'stacked',
        dependencyReason: 'reads the settings table PR 1 introduces',
      }),
      slot({
        number: 3,
        base: 'feat/task-1',
        dependsOn: 'PR 1',
        dependencyType: 'stacked',
        dependencyReason: 'projects the same audit vocabulary',
        state: 'ACTIVE',
        prNumber: null,
        headSha: null,
      }),
    ],
  });
  const result = parseTrain(text);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
  assert.equal(result.train.slots.length, 3);
  assert.equal(result.train.id, 'product-foundation');
  assert.equal(result.train.configuredLimit, 3);
  assert.equal(result.train.slots[1].prNumber, 102);
  assert.equal(result.train.slots[2].prNumber, null);
});

// 3. Sibling dependencies are preserved correctly.
test('siblings share a dependency and do not depend on each other', () => {
  const text = dashboard({
    slots: [
      slot({ number: 1, state: 'READY_FOR_HUMAN' }),
      slot({ number: 2, base: 'feat/task-1', dependsOn: 'PR 1', dependencyType: 'stacked', dependencyReason: 'r' }),
      slot({ number: 3, base: 'feat/task-1', dependsOn: 'PR 1', dependencyType: 'stacked', dependencyReason: 'r' }),
    ],
  });
  const { train, valid } = parseTrain(text);
  assert.equal(valid, true);
  assert.deepEqual(train.slots[1].dependsOn, [1]);
  assert.deepEqual(train.slots[2].dependsOn, [1]);
  // The anti-pattern this guards: PR 3 must not depend on PR 2 merely because
  // PR 3 was created later.
  assert.ok(!train.slots[2].dependsOn.includes(2));
  assert.deepEqual(siblingGroups(train), [{ sharedDependency: '1', members: [2, 3] }]);
});

test('a sibling recorded as depending on its sibling is a contradiction, not a deep stack', () => {
  const text = dashboard({
    slots: [
      slot({ number: 1, state: 'READY_FOR_HUMAN' }),
      slot({ number: 2, base: 'feat/task-1', dependsOn: 'PR 1', dependencyType: 'stacked', dependencyReason: 'r' }),
      // Base still points at PR 1's branch, but the dashboard claims PR 2.
      slot({ number: 3, base: 'feat/task-1', dependsOn: 'PR 2', dependencyType: 'stacked', dependencyReason: 'r' }),
    ],
  });
  const result = parseTrain(text);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /PR 3: depends on PR 2 but its base is "feat\/task-1"/);
});

// 4. A true stacked dependency is preserved correctly.
test('a true stack keeps its base/dependency agreement', () => {
  const text = dashboard({
    current: 2,
    slots: [
      slot({ number: 1, state: 'READY_FOR_HUMAN' }),
      slot({
        number: 2,
        base: 'feat/task-1',
        dependsOn: 'PR 1',
        dependencyType: 'stacked',
        dependencyReason: 'calls the API PR 1 adds',
      }),
    ],
  });
  const { train, valid } = parseTrain(text);
  assert.equal(valid, true);
  assert.equal(train.slots[1].base, 'feat/task-1');
  assert.equal(train.slots[1].dependencyType, 'stacked');
  assert.equal(train.slots[1].dependencyReason, 'calls the API PR 1 adds');
});

test('a non-main base with no declared dependency is refused', () => {
  const text = dashboard({ slots: [slot({ number: 1, base: 'feat/other', dependsOn: 'none' })] });
  const result = parseTrain(text);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /no dependency is recorded/);
});

test('stacking without a stated reason warns, because "written later" is not a dependency', () => {
  const text = dashboard({
    slots: [
      slot({ number: 1, state: 'READY_FOR_HUMAN' }),
      slot({ number: 2, base: 'feat/task-1', dependsOn: 'PR 1', dependencyType: 'stacked' }),
    ],
  });
  const result = parseTrain(text);
  assert.equal(result.valid, true);
  assert.match(result.warnings.join('\n'), /without a "Dependency reason"/);
});

test('a dependency cycle fails closed', () => {
  const text = dashboard({
    slots: [
      slot({ number: 1, base: 'feat/task-2', dependsOn: 'PR 2', dependencyType: 'stacked', dependencyReason: 'r' }),
      slot({ number: 2, base: 'feat/task-1', dependsOn: 'PR 1', dependencyType: 'stacked', dependencyReason: 'r' }),
    ],
  });
  const result = parseTrain(text);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /dependency cycle/);
});

// 5. Current PR is resolved correctly.
test('the declared current slot wins when it is live', () => {
  const text = dashboard({
    current: 2,
    slots: [slot({ number: 1, state: 'MERGED' }), slot({ number: 2, state: 'ACTIVE', prNumber: null, headSha: null })],
  });
  const { train } = parseTrain(text);
  const resolved = resolveCurrent(train);
  assert.equal(resolved.current.slot, 2);
  assert.equal(resolved.inferred, false);
});

test('a current slot recorded as MERGED is a contradiction', () => {
  const text = dashboard({ current: 1, slots: [slot({ number: 1, state: 'MERGED' })] });
  const result = parseTrain(text);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /recorded as MERGED; the current slot must be live work/);
});

test('a missing current slot is inferred as the lowest live slot and flagged as inferred', () => {
  const text = dashboard({
    current: null,
    slots: [slot({ number: 1, state: 'MERGED' }), slot({ number: 2, state: 'PR_OPEN', headSha: null })],
  });
  const { train, warnings } = parseTrain(text);
  const resolved = resolveCurrent(train);
  assert.equal(resolved.current.slot, 2);
  assert.equal(resolved.inferred, true);
  assert.match(warnings.join('\n'), /does not record "Current PR"/);
});

// 6. Next action is resolved correctly.
test('the recorded next action is used verbatim', () => {
  const text = dashboard({ slots: [slot({ number: 1, nextAction: 'open the PR against main' })] });
  const { train } = parseTrain(text);
  assert.equal(resolveCurrent(train).nextAction, 'open the PR against main');
});

test('with no recorded next action the first unchecked checklist item is used', () => {
  const checklist = `Checklist:
- [x] discovery
- [x] design
- [ ] implementation
- [ ] narrow verification
- [ ] aggregate verification
- [ ] self-review
- [ ] specialist review where required
- [ ] repair
- [ ] final-head CI
- [ ] human handoff`;
  const text = dashboard({
    slots: [slot({ number: 1, state: 'ACTIVE', prNumber: null, headSha: null, nextAction: 'none', checklist })],
  });
  const { train } = parseTrain(text);
  assert.match(resolveCurrent(train).nextAction, /Continue PR 1: implementation/);
});

test('an unverified dependency blocks dependent work but not sibling work', () => {
  const base = [
    slot({ number: 1, state: 'CI_PENDING', headSha: null }),
    slot({
      number: 2,
      base: 'feat/task-1',
      dependsOn: 'PR 1',
      dependencyType: 'stacked',
      dependencyReason: 'r',
      state: 'ACTIVE',
      prNumber: null,
      headSha: null,
      nextAction: 'none',
    }),
  ];
  const dependent = parseTrain(dashboard({ current: 2, slots: base }));
  assert.equal(dependent.valid, true);
  const blocked = resolveCurrent(dependent.train);
  assert.equal(blocked.blocked, true);
  assert.match(blocked.nextAction, /must not build on an unverified change/);

  // A sibling of the pending PR shares its ancestor, not its change, so it runs.
  const sibling = parseTrain(
    dashboard({
      current: 2,
      slots: [
        slot({ number: 1, state: 'CI_PENDING', headSha: null }),
        slot({ number: 2, state: 'ACTIVE', prNumber: null, headSha: null, nextAction: 'implement' }),
      ],
    }),
  );
  assert.equal(resolveCurrent(sibling.train).blocked, false);
});

test('a BLOCKED slot reports its blocker as the next action', () => {
  const text = dashboard({ slots: [slot({ number: 1, state: BLOCKED, nextAction: 'none' })] });
  const { train } = parseTrain(text);
  assert.match(resolveCurrent(train).nextAction, /is BLOCKED/);
});

// 7. Configured limit of 3 refuses a fourth PR.
test('limit 3 refuses a fourth PR', () => {
  const text = dashboard({
    limit: 3,
    current: 3,
    slots: [slot({ number: 1 }), slot({ number: 2 }), slot({ number: 3 })],
  });
  const { train, valid } = parseTrain(text);
  assert.equal(valid, true);
  const status = trainLimitStatus(train);
  assert.equal(status.allowed, false);
  assert.equal(status.occupied, 3);
  assert.equal(status.limit, 3);
  assert.ok(status.message.startsWith(TRAIN_LIMIT_REACHED));
  assert.match(status.message, /Do not begin another roadmap PR/);
});

// 8. Configured limit of 4 permits slot 4.
test('limit 4 permits a fourth slot', () => {
  const three = dashboard({
    limit: 4,
    current: 3,
    slots: [slot({ number: 1 }), slot({ number: 2 }), slot({ number: 3 })],
  });
  const status = trainLimitStatus(parseTrain(three).train);
  assert.equal(status.allowed, true);
  assert.equal(status.limit, 4);

  const four = dashboard({
    limit: 4,
    current: 4,
    slots: [slot({ number: 1 }), slot({ number: 2 }), slot({ number: 3 }), slot({ number: 4 })],
  });
  const parsedFour = parseTrain(four);
  assert.equal(parsedFour.valid, true);
  assert.equal(trainLimitStatus(parsedFour.train).allowed, false);
});

// 9. Exceeding the hard ceiling refuses.
test('a configured limit above the hard ceiling fails closed', () => {
  const result = parseTrain(dashboard({ limit: 5 }));
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), new RegExp(`above the supported ceiling of ${TRAIN_LIMIT_CEILING}`));
});

test('the ceiling still refuses progression even if parsing were tolerated', () => {
  // trainLimitStatus is called by resume on an already-parsed train, so it must
  // refuse independently rather than relying on the parser having rejected it.
  const status = trainLimitStatus({ configuredLimit: 9, slots: [] });
  assert.equal(status.allowed, false);
  assert.match(status.message, /exceeds the supported ceiling/);
});

test('released states do not consume train capacity', () => {
  const text = dashboard({
    limit: 3,
    current: 3,
    slots: [
      slot({ number: 1, state: 'MERGED' }),
      slot({ number: 2, state: 'PLANNED', prNumber: null, headSha: null, nextAction: 'none' }),
      slot({ number: 3, state: 'ACTIVE', prNumber: null, headSha: null }),
    ],
  });
  const { train } = parseTrain(text);
  assert.deepEqual(occupiedSlots(train).map((entry) => entry.slot), [3]);
  assert.equal(trainLimitStatus(train).allowed, true);
});

test('the default configured limit is 3 when the dashboard omits it', () => {
  const text = dashboard().replace('Configured max open PRs: 3\n', '');
  const result = parseTrain(text);
  assert.equal(result.train.configuredLimit, DEFAULT_TRAIN_LIMIT);
  assert.match(result.warnings.join('\n'), /assuming the default/);
});

// 10. TODO head mismatch is surfaced.
test('a head SHA mismatch against GitHub is surfaced', () => {
  const { train } = parseTrain(dashboard());
  const findings = reconcile(train, {
    prs: { 101: { state: 'OPEN', headSha: 'ffffffffffffffffffffffffffffffffffffffff' } },
  });
  assert.ok(findings.some((entry) => /records head .* but #101 head is/.test(entry.message)));
});

// 11. PR base mismatch is surfaced.
test('a base mismatch against GitHub is surfaced and never auto-fixed', () => {
  const { train } = parseTrain(dashboard());
  const findings = reconcile(train, { prs: { 101: { state: 'OPEN', baseRefName: 'develop' } } });
  const finding = findings.find((entry) => /records base "main" but #101 targets "develop"/.test(entry.message));
  assert.ok(finding);
  assert.match(finding.action, /do not force-push/);
});

// 12. A merged dependency is surfaced for reconciliation.
test('a merged ancestor surfaces a retarget finding', () => {
  const text = dashboard({
    current: 2,
    slots: [
      slot({ number: 1, state: 'READY_FOR_HUMAN' }),
      slot({ number: 2, base: 'feat/task-1', dependsOn: 'PR 1', dependencyType: 'stacked', dependencyReason: 'r' }),
    ],
  });
  const { train } = parseTrain(text);
  const findings = reconcile(train, { prs: { 101: { state: 'MERGED' }, 102: { state: 'OPEN' } } });
  const retarget = findings.find((entry) => entry.severity === 'retarget');
  assert.ok(retarget);
  assert.match(retarget.message, /needs human-safe reconciliation to main/);
  assert.match(retarget.action, /do not force-push history/);
});

test('a PR merged behind the dashboard lets GitHub win', () => {
  const { train } = parseTrain(dashboard());
  const findings = reconcile(train, { prs: { 101: { state: 'MERGED' } } });
  const finding = findings.find((entry) => /is MERGED on GitHub but recorded as CI_GREEN/.test(entry.message));
  assert.ok(finding);
  assert.match(finding.action, /GitHub wins/);
});

// 13. CI failure does not become CI_GREEN.
test('a failing check contradicts a recorded CI_GREEN', () => {
  const { train } = parseTrain(dashboard());
  const findings = reconcile(train, { prs: { 101: { state: 'OPEN', checks: 'FAILURE' } } });
  const finding = findings.find((entry) => entry.severity === 'contradiction');
  assert.ok(finding);
  assert.match(finding.message, /checks are FAILURE/);
  assert.match(finding.action, /CI evidence outranks the dashboard/);
});

test('a state claiming verification without a head SHA fails closed', () => {
  const text = dashboard({ slots: [slot({ number: 1, state: 'CI_GREEN', headSha: null })] });
  const result = parseTrain(text);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /asserts a verified commit but no "Head SHA"/);
});

test('a state claiming an open PR without a PR number fails closed', () => {
  const text = dashboard({ slots: [slot({ number: 1, state: 'PR_OPEN', prNumber: null, headSha: null })] });
  const result = parseTrain(text);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /asserts an open pull request but no "PR number"/);
});

// 14. Unresolved findings survive and are read on resume.
test('unresolved findings are parsed and re-reported on resume', () => {
  const text = dashboard({
    extra: [
      '',
      '# UNRESOLVED FINDINGS',
      '',
      '- [ ] platform lint rule disagrees with the shared config',
      '- [x] already repaired: duplicated DTO',
      '',
    ].join('\n'),
  });
  const { train, valid } = parseTrain(text);
  assert.equal(valid, true);
  assert.equal(train.findings.length, 2);
  const findings = reconcile(train, {});
  const carried = findings.filter((entry) => entry.severity === 'unresolved-finding');
  assert.equal(carried.length, 1);
  assert.match(carried[0].message, /platform lint rule/);
});

test('a wrapped finding keeps its whole text', () => {
  // Regression: reading only the first line of a list item turned a finding into
  // a fragment, which is worse than losing it because the fragment looks whole.
  const text = dashboard({
    extra: [
      '',
      '# UNRESOLVED FINDINGS',
      '',
      '- [ ] the platform lint rule disagrees with the shared config',
      '      and the disagreement only appears on the second run',
      '- [ ] a second, unrelated finding',
      '',
    ].join('\n'),
  });
  const { train } = parseTrain(text);
  assert.equal(train.findings.length, 2);
  assert.match(train.findings[0].text, /only appears on the second run$/);
  assert.equal(train.findings[1].text, 'a second, unrelated finding');
});

test('checklist coverage is matched case-insensitively', () => {
  // Regression: the step list is mixed case ("final-head CI") and labels were
  // lowercased before comparison, so that step always reported as uncovered.
  const result = parseTrain(dashboard());
  assert.equal(
    result.warnings.filter((warning) => /checklist does not cover/.test(warning)).length,
    0,
    result.warnings.join('\n'),
  );

  const missing = parseTrain(
    dashboard({
      slots: [slot({ number: 1, checklist: 'Checklist:\n- [x] discovery' })],
    }),
  );
  assert.match(missing.warnings.join('\n'), /checklist does not cover "final-head CI"/);
});

// 15. Uncommitted work is reported, not discarded.
test('inherited uncommitted work is reported with an explicit do-not-discard action', () => {
  const { train } = parseTrain(dashboard());
  const findings = reconcile(train, { dirtyPaths: ['.vscode/settings.json', 'apps/web/page.tsx'] });
  const finding = findings.find((entry) => entry.severity === 'inherited-work');
  assert.ok(finding);
  assert.match(finding.message, /2 path\(s\)/);
  assert.match(finding.action, /never reset, stash, clean, or discard/);
});

// 16. Missing TODO fails safely.
test('an empty or non-string dashboard fails closed rather than parsing to an empty train', () => {
  for (const input of ['', '   ', null, undefined, 42]) {
    const result = parseTrain(input);
    assert.equal(result.valid, false, JSON.stringify(input));
    assert.equal(result.train, null);
  }
});

// 18. Malformed/ambiguous train state fails closed.
test('a malformed slot heading fails closed', () => {
  const text = dashboard().replace('## PR 1 — TASK-01', '## the first one');
  const result = parseTrain(text);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /malformed PR slot heading/);
});

test('a duplicate slot number fails closed', () => {
  const text = dashboard({ slots: [slot({ number: 1 }), slot({ number: 1, branch: 'feat/other' })] });
  const result = parseTrain(text);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /duplicate PR slot 1/);
});

test('an unknown state literal fails closed', () => {
  const text = dashboard({ slots: [slot({ number: 1, state: 'PROBABLY_FINE' })] });
  const result = parseTrain(text);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /unknown state "PROBABLY_FINE"/);
});

test('an unparseable dependency is reported rather than dropped', () => {
  const text = dashboard({
    slots: [slot({ number: 1, dependsOn: 'the previous one', dependencyType: 'stacked', dependencyReason: 'r' })],
  });
  const result = parseTrain(text);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /cannot parse dependency "the previous one"/);
});

test('a dependency on a slot outside the train fails closed', () => {
  const text = dashboard({
    slots: [slot({ number: 1, base: 'feat/task-9', dependsOn: 'PR 9', dependencyType: 'stacked', dependencyReason: 'r' })],
  });
  const result = parseTrain(text);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /not a slot in this train/);
});

test('a current PR naming a nonexistent slot fails closed', () => {
  const result = parseTrain(dashboard({ current: 7 }));
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /names PR 7, which is not a slot/);
});

test('declaring independent while recording a dependency fails closed', () => {
  const text = dashboard({
    slots: [
      slot({ number: 1, state: 'READY_FOR_HUMAN' }),
      slot({ number: 2, base: 'feat/task-1', dependsOn: 'PR 1', dependencyType: 'independent' }),
    ],
  });
  const result = parseTrain(text);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /contradicts "Depends on: PR 1"/);
});

test('contradicting evidence overrides the recorded next action for the current slot', () => {
  const text = dashboard({ slots: [slot({ number: 1, nextAction: 'human merge' })] });
  const clean = analyze(text, { prs: { 101: { state: 'OPEN', checks: 'SUCCESS' } } });
  assert.equal(clean.nextAction, 'human merge');

  // A CI_GREEN claim contradicted by real checks must not leave "human merge"
  // standing as the instruction.
  const conflicted = analyze(text, { prs: { 101: { state: 'OPEN', checks: 'FAILURE' } } });
  assert.match(conflicted.nextAction, /^RESOLVE EVIDENCE CONFLICT FIRST for PR 1/);
  assert.match(conflicted.nextAction, /checks are FAILURE/);
  assert.equal(conflicted.recordedNextAction, 'human merge');
});

test('drift on another slot does not hijack the current slot\'s next action', () => {
  const text = dashboard({
    current: 2,
    slots: [
      slot({ number: 1, state: 'PR_OPEN', headSha: null }),
      slot({ number: 2, state: 'ACTIVE', prNumber: null, headSha: null, nextAction: 'implement the parser' }),
    ],
  });
  // PR 1's base drifted; PR 2 is current and unaffected.
  const result = analyze(text, { prs: { 101: { state: 'OPEN', baseRefName: 'develop' } } });
  assert.ok(result.reconciliation.some((entry) => /records base "main" but #101/.test(entry.message)));
  assert.equal(result.nextAction, 'implement the parser');
});

test('main advancing past the anchor blocks the current slot until resolved', () => {
  const text = dashboard();
  const result = analyze(text, { mainSha: 'ffffffffffffffffffffffffffffffffffffffff' });
  assert.match(result.nextAction, /RESOLVE EVIDENCE CONFLICT FIRST/);
  assert.match(result.nextAction, /anchor main SHA/);
});

// 19. No merge/force-push/reset/stash behavior is introduced.
test('the module never proposes a destructive or merging action', () => {
  const text = dashboard({
    current: 2,
    slots: [
      slot({ number: 1, state: 'READY_FOR_HUMAN' }),
      slot({ number: 2, base: 'feat/task-1', dependsOn: 'PR 1', dependencyType: 'stacked', dependencyReason: 'r' }),
    ],
    extra: '\n# UNRESOLVED FINDINGS\n\n- [ ] something open\n',
  });
  const result = analyze(text, {
    mainSha: 'ffffffffffffffffffffffffffffffffffffffff',
    branch: 'somewhere-else',
    dirtyPaths: ['a.ts'],
    prs: { 101: { state: 'MERGED' }, 102: { state: 'OPEN', checks: 'FAILURE', baseRefName: 'develop' } },
  });
  const emitted = [
    result.nextAction,
    result.limit.message,
    ...result.reconciliation.flatMap((entry) => [entry.message, entry.action ?? '']),
  ].join('\n');
  // Imperatives the harness must never produce. Negated mentions are fine and
  // expected ("do not force-push"), so each pattern requires an instruction.
  for (const forbidden of [
    /(?<!not )\bgit reset\b/,
    /(?<!not )\bgit stash\b/,
    /(?<!not )\bgit clean\b/,
    /(?<!not )\bpush --force\b/,
    /(?<!not )\bgh pr merge\b/,
    /--admin\b/,
    /auto-?merge\b(?! is)/i,
  ]) {
    assert.ok(!forbidden.test(emitted), `emitted a forbidden action matching ${forbidden}: ${emitted}`);
  }
});

test('analyze surfaces every reconciliation class at once without throwing', () => {
  const text = dashboard({
    current: 2,
    slots: [
      slot({ number: 1, state: 'READY_FOR_HUMAN' }),
      slot({ number: 2, base: 'feat/task-1', dependsOn: 'PR 1', dependencyType: 'stacked', dependencyReason: 'r' }),
    ],
  });
  const result = analyze(text, {
    mainSha: 'ffffffffffffffffffffffffffffffffffffffff',
    branch: 'elsewhere',
    dirtyPaths: ['x.ts'],
    prs: { 101: { state: 'MERGED' }, 102: { state: 'OPEN', checks: 'FAILURE' } },
  });
  const severities = new Set(result.reconciliation.map((entry) => entry.severity));
  for (const expected of ['drift', 'inherited-work', 'contradiction', 'retarget']) {
    assert.ok(severities.has(expected), `missing ${expected}`);
  }
});

test('a short dashboard SHA matches a full evidence SHA', () => {
  const { train } = parseTrain(dashboard());
  const findings = reconcile(train, { mainSha: '9a90e1f5befa3048a258858066d3c6bc5a822ad7' });
  assert.ok(!findings.some((entry) => /anchor main SHA/.test(entry.message)));
});

test('analyze on an invalid dashboard returns no next action rather than a guess', () => {
  const result = analyze('# ACTIVE PR\n\n## [ACTIVE] something\n');
  assert.equal(result.valid, false);
  assert.equal(result.current, null);
  assert.equal(result.limit, null);
});

// 17. TODO not ignored produces a warning; tracked produces a refusal.
test('the dashboard-file contract refuses a tracked dashboard and warns on an unignored one', () => {
  assert.deepEqual(
    dashboardFileDecision({ exists: true, tracked: false, ignored: true }),
    { ok: true, severity: 'ok', message: 'dashboard file is local and ignored.' },
  );

  const unignored = dashboardFileDecision({ exists: true, tracked: false, ignored: false });
  assert.equal(unignored.ok, true);
  assert.equal(unignored.severity, 'warn');
  assert.match(unignored.message, /only explicit paths/);

  const tracked = dashboardFileDecision({ exists: true, tracked: true, ignored: false });
  assert.equal(tracked.ok, false);
  assert.equal(tracked.severity, 'refuse');
  assert.match(tracked.message, /tracked by Git/);

  // Missing is a refusal, and must not suggest reconstructing from memory.
  const missing = dashboardFileDecision({ exists: false, tracked: false, ignored: true });
  assert.equal(missing.ok, false);
  assert.equal(missing.severity, 'refuse');
  assert.match(missing.message, /do not invent train state from memory/);
});

// 19 (static half). Neither harness script may contain a destructive or merging
// command at all. The behavioural test above covers emitted advice; this covers
// the source, so a future edit cannot introduce one in a code path no fixture
// reaches.
test('no harness script contains a destructive, merging, or force-pushing command', () => {
  const scripts = ['../pr-train.mjs', '../resume-task.mjs'];
  for (const relative of scripts) {
    const path = resolve(dirname(fileURLToPath(import.meta.url)), relative);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, 'utf8');
    // Fragments are split so this test file does not contain the literals either.
    for (const forbidden of [
      "'reset'",
      "'stash'",
      "'clean'",
      '--force',
      "'merge'",
      'pr merge',
      'auto-merge --',
      '--admin',
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `${relative} contains a forbidden command fragment: ${forbidden}`,
      );
    }
    // Resume reports; it never publishes. Matched as an argv element or a
    // command string rather than as a bare word, because `errors.push(...)` is
    // ordinary array use and a pattern that flags it proves nothing.
    assert.ok(!/(['"`])push\1/.test(source), `${relative} passes push as a command argument`);
    assert.ok(!/\bgit\s+push\b/.test(source), `${relative} contains a git push command`);
  }
});

// 20. Mutation probe: removing the train-limit guard must fail a test.
test('removing the train-limit guard breaks the limit contract', async () => {
  const moduleDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const source = readFileSync(resolve(moduleDir, 'pr-train.mjs'), 'utf8');

  const guard = `  if (occupied.length >= limit) {`;
  assert.ok(source.includes(guard), 'probe anchor missing; the limit guard was renamed or removed');

  const mutated = source.replace(guard, `  if (false) {`);
  const probePath = resolve(moduleDir, '__tests__', '.pr-train.limit-probe.mjs');
  writeFileSync(probePath, mutated);

  try {
    const mutant = await import(`${pathToFileURL(probePath).href}?probe=limit`);
    const full = dashboard({
      limit: 3,
      current: 3,
      slots: [slot({ number: 1 }), slot({ number: 2 }), slot({ number: 3 })],
    });
    const parsed = mutant.parseTrain(full);
    assert.equal(parsed.valid, true, 'the probe must differ only in the guard');

    // The real module refuses this train; the mutant must not, or the guard is
    // not what refuses and the limit tests prove nothing.
    assert.equal(trainLimitStatus(parsed.train).allowed, false, 'baseline expectation changed');
    assert.equal(
      mutant.trainLimitStatus(parsed.train).allowed,
      true,
      'removing the limit guard still refused a full train; the guard is not load-bearing',
    );
  } finally {
    rmSync(probePath, { force: true });
  }
});

// Mutation probe: removing the base/dependency agreement check must let a
// sibling be recorded as a deep stack.
test('removing the base/dependency agreement check lets siblings become a deep stack', async () => {
  const moduleDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const source = readFileSync(resolve(moduleDir, 'pr-train.mjs'), 'utf8');

  const guard = `      if (parent.branch && slot.base && slot.base !== parent.branch && parent.state !== 'MERGED') {`;
  assert.ok(source.includes(guard), 'probe anchor missing; the agreement check was renamed or removed');

  const mutated = source.replace(guard, `      if (false) {`);
  const probePath = resolve(moduleDir, '__tests__', '.pr-train.stack-probe.mjs');
  writeFileSync(probePath, mutated);

  try {
    const mutant = await import(`${pathToFileURL(probePath).href}?probe=stack`);
    const falseStack = dashboard({
      slots: [
        slot({ number: 1, state: 'READY_FOR_HUMAN' }),
        slot({ number: 2, base: 'feat/task-1', dependsOn: 'PR 1', dependencyType: 'stacked', dependencyReason: 'r' }),
        // Based on PR 1 but claiming to depend on PR 2: the accidental deep stack.
        slot({ number: 3, base: 'feat/task-1', dependsOn: 'PR 2', dependencyType: 'stacked', dependencyReason: 'r' }),
      ],
    });
    assert.equal(parseTrain(falseStack).valid, false, 'baseline expectation changed');
    assert.equal(
      mutant.parseTrain(falseStack).valid,
      true,
      'removing the agreement check still refused a false stack; the check is not load-bearing',
    );
  } finally {
    rmSync(probePath, { force: true });
  }
});
