#!/usr/bin/env node
import { lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const errors = [];
const expectedRoles = [
  'code-reviewer',
  'debugger',
  'docs-researcher',
  'explorer',
  'implementer',
  'security-reviewer',
  'test-engineer',
];
const requiredRoleHeadings = [
  'Purpose',
  'When to use',
  'When not to use',
  'Input contract',
  'Required context',
  'Allowed actions',
  'Forbidden actions',
  'Output contract',
  'Validation and evidence',
  'Stopping conditions',
  'Escalation',
];

function fail(message) {
  errors.push(message);
}

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function read(path) {
  return readFileSync(path, 'utf8');
}

function filesUnder(path) {
  const results = [];
  if (!exists(path)) return results;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) results.push(...filesUnder(child));
    else results.push(child);
  }
  return results;
}

function frontmatter(path) {
  const source = read(path);
  if (!source.startsWith('---\n')) return null;
  const end = source.indexOf('\n---\n', 4);
  if (end === -1) return null;
  const values = {};
  for (const line of source.slice(4, end).split('\n')) {
    const separator = line.indexOf(':');
    if (separator > 0) values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return values;
}

function sortedNames(path, extension) {
  if (!exists(path)) return [];
  return readdirSync(path)
    .filter((name) => name.endsWith(extension) && name !== `README${extension}`)
    .map((name) => name.slice(0, -extension.length))
    .sort();
}

function sameList(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} set differs: expected [${expected.join(', ')}], got [${actual.join(', ')}]`);
  }
}

function validateCanonicalFiles() {
  const required = [
    'AGENTS.md',
    'CLAUDE.md',
    '.agents/task-brief.md',
    '.agents/policies/engineering.md',
    '.agents/policies/safety.md',
    '.agents/policies/git-and-delivery.md',
    '.agents/workflows/feature-implementation.md',
    '.agents/workflows/bug-fixing.md',
    '.agents/workflows/pr-review.md',
    '.agents/workflows/incident-debugging.md',
    '.agents/workflows/documentation-sync.md',
    '.agents/hooks/policy.mjs',
    '.agents/hooks/pre-tool.mjs',
    '.agents/hooks/stop-check.mjs',
    '.codex/hooks.json',
    '.claude/settings.json',
    '.cursor/hooks.json',
    'docs/deployment-state.md',
  ];
  for (const file of required) if (!exists(join(root, file))) fail(`missing canonical file: ${file}`);

  const firstLine = read(join(root, 'CLAUDE.md')).split(/\r?\n/, 1)[0];
  if (firstLine !== '@AGENTS.md') fail('CLAUDE.md must begin with the exact @AGENTS.md import');
}

function validateRolesAndAdapters() {
  const canonical = sortedNames(join(root, '.agents/roles'), '.md');
  sameList(canonical, expectedRoles, 'canonical role');

  for (const role of expectedRoles) {
    const rolePath = join(root, '.agents/roles', `${role}.md`);
    if (!exists(rolePath)) continue;
    const source = read(rolePath);
    for (const heading of requiredRoleHeadings) {
      if (!source.includes(`## ${heading}\n`)) fail(`${relative(root, rolePath)} lacks "${heading}"`);
    }
  }

  const adapters = [
    ['Codex', '.codex/agents', '.toml'],
    ['Claude', '.claude/agents', '.md'],
    ['Cursor', '.cursor/agents', '.md'],
  ];
  for (const [label, directory, extension] of adapters) {
    sameList(sortedNames(join(root, directory), extension), expectedRoles, `${label} adapter`);
    for (const role of expectedRoles) {
      const path = join(root, directory, `${role}${extension}`);
      if (!exists(path)) continue;
      const source = read(path);
      if (!source.includes(`.agents/roles/${role}.md`)) fail(`${relative(root, path)} does not route to its canonical role`);
      if (extension === '.toml') {
        for (const key of ['name', 'description', 'developer_instructions']) {
          if (!new RegExp(`^${key}\\s*=`, 'm').test(source)) fail(`${relative(root, path)} lacks ${key}`);
        }
      } else {
        const meta = frontmatter(path);
        if (!meta?.name || !meta?.description) fail(`${relative(root, path)} lacks name/description frontmatter`);
      }
    }
  }
}

function validateSkills() {
  const skillRoot = join(root, '.agents/skills');
  const skillNames = readdirSync(skillRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && exists(join(skillRoot, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();

  for (const name of skillNames) {
    const path = join(skillRoot, name, 'SKILL.md');
    const meta = frontmatter(path);
    if (!meta?.name || !meta?.description) fail(`${relative(root, path)} lacks name/description frontmatter`);
  }

  const claudeSkills = join(root, '.claude/skills');
  if (!exists(claudeSkills)) {
    fail('missing Claude skill adapter directory: .claude/skills');
    return;
  }
  const exposed = readdirSync(claudeSkills).sort();
  sameList(exposed, skillNames, 'Claude skill adapter');
  for (const name of exposed) {
    const adapter = join(claudeSkills, name);
    if (!lstatSync(adapter).isSymbolicLink()) {
      fail(`${relative(root, adapter)} must be a symlink; this checkout may have materialized Git link text (check core.symlinks and the Windows symlink prerequisite)`);
      continue;
    }
    const target = resolve(dirname(adapter), readlinkSync(adapter));
    try {
      if (realpathSync(target) !== realpathSync(join(skillRoot, name))) {
        fail(`${relative(root, adapter)} points outside the canonical skill directory`);
      }
    } catch {
      fail(`${relative(root, adapter)} is a broken skill symlink`);
    }
  }

  for (const directory of ['.codex', '.cursor', '.claude']) {
    for (const file of filesUnder(join(root, directory))) {
      if (file.endsWith('SKILL.md') && !lstatSync(dirname(file)).isSymbolicLink()) {
        fail(`copied tool-specific skill found: ${relative(root, file)}`);
      }
    }
  }
}

function validateWorkflows() {
  for (const path of filesUnder(join(root, '.agents/workflows')).filter((file) => file.endsWith('.md') && !file.endsWith('README.md'))) {
    const source = read(path);
    if (!source.includes('## State graph\n')) fail(`${relative(root, path)} lacks an explicit state graph`);
    if (!/(three|3).*(cycle|attempt)|(?:cycle|attempt).*(three|3)/is.test(source)) fail(`${relative(root, path)} lacks a bounded three-cycle loop`);
    if (!source.includes('ESCALATE')) fail(`${relative(root, path)} lacks an escalation state`);
  }
}

function validateHooks() {
  const configs = {};
  for (const config of ['.codex/hooks.json', '.claude/settings.json', '.cursor/hooks.json']) {
    try {
      configs[config] = JSON.parse(read(join(root, config)));
    } catch (error) {
      fail(`${config} is invalid JSON: ${error.message}`);
    }
  }

  for (const script of ['.agents/hooks/policy.mjs', '.agents/hooks/pre-tool.mjs', '.agents/hooks/stop-check.mjs']) {
    const result = spawnSync(process.execPath, ['--check', script], { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) fail(`${script} fails node --check: ${(result.stderr || result.stdout).trim()}`);
  }

  const hookScripts = [
    ['PreToolUse', 'pre-tool.mjs'],
    ['Stop', 'stop-check.mjs'],
  ];

  const codex = configs['.codex/hooks.json'];
  for (const [event, script] of hookScripts) {
    const hook = codex?.hooks?.[event]?.[0]?.hooks?.[0];
    const posix = `node \"$(git rev-parse --show-toplevel)/.agents/hooks/${script}\" codex`;
    const windows = `powershell.exe -NoProfile -NonInteractive -Command \"$root = git rev-parse --show-toplevel; & node (Join-Path $root '.agents/hooks/${script}') codex\"`;
    if (hook?.command !== posix) fail(`.codex/hooks.json ${event} must resolve ${script} from the POSIX Git root`);
    if (hook?.commandWindows !== windows) fail(`.codex/hooks.json ${event} must resolve ${script} from the Windows Git root`);
  }

  const claude = configs['.claude/settings.json'];
  for (const [event, script] of hookScripts) {
    const hook = claude?.hooks?.[event]?.[0]?.hooks?.[0];
    if (hook?.command !== 'node') fail(`.claude/settings.json ${event} must use command-hook exec form`);
    if (JSON.stringify(hook?.args) !== JSON.stringify([`${'${CLAUDE_PROJECT_DIR}'}/.agents/hooks/${script}`, 'claude'])) {
      fail(`.claude/settings.json ${event} must resolve ${script} from CLAUDE_PROJECT_DIR`);
    }
  }

  const cursor = configs['.cursor/hooks.json'];
  const cursorHooks = [
    ['preToolUse', 'pre-tool.mjs'],
    ['stop', 'stop-check.mjs'],
  ];
  for (const [event, script] of cursorHooks) {
    const hook = cursor?.hooks?.[event]?.[0];
    if (hook?.command !== `node .agents/hooks/${script} cursor`) {
      fail(`.cursor/hooks.json ${event} must use the documented project-root cwd for ${script}`);
    }
  }
  if (cursor?.hooks?.stop?.[0]?.loop_limit !== 2) fail('.cursor/hooks.json stop must keep the bounded loop_limit of 2');
}

function validateMarkdownLinks() {
  const agentDocs = filesUnder(join(root, '.agents')).filter(
    (path) => !path.startsWith(join(root, '.agents/skills') + '/'),
  );
  const markdown = [
    ...filesUnder(join(root, 'docs')),
    ...agentDocs,
    join(root, 'README.md'),
    join(root, 'AGENTS.md'),
    join(root, 'CLAUDE.md'),
  ].filter((path) => extname(path).toLowerCase() === '.md');

  for (const path of markdown) {
    const source = read(path);
    for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      let target = match[1].trim().replace(/^<|>$/g, '').split('#', 1)[0];
      if (!target || /^(?:https?:|mailto:|tel:)/i.test(target)) continue;
      try {
        target = decodeURIComponent(target);
      } catch {
        fail(`${relative(root, path)} has an invalid encoded link: ${match[1]}`);
        continue;
      }
      const destination = target.startsWith('/') ? join(root, target) : resolve(dirname(path), target);
      if (!exists(destination)) fail(`${relative(root, path)} links to missing path: ${match[1]}`);
    }
  }
}

function validateSafetyAndState() {
  const ownedAgentFiles = filesUnder(join(root, '.agents')).filter(
    (path) => !path.startsWith(join(root, '.agents/skills') + '/'),
  );
  const scanned = [
    ...ownedAgentFiles,
    ...filesUnder(join(root, '.codex')),
    ...filesUnder(join(root, '.claude')),
    ...filesUnder(join(root, '.cursor')),
    ...filesUnder(join(root, 'docs')),
    join(root, 'README.md'),
    join(root, 'AGENTS.md'),
    join(root, 'CLAUDE.md'),
  ].filter((path) => lstatSync(path).isFile());
  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bghp_[A-Za-z0-9]{30,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bsk-[A-Za-z0-9]{32,}\b/,
  ];
  for (const path of scanned) {
    const source = read(path);
    if (secretPatterns.some((pattern) => pattern.test(source))) fail(`possible high-confidence secret literal in ${relative(root, path)}`);
  }

  const deployment = read(join(root, 'docs/deployment-state.md'));
  if (!/\|\s*Staging\s*\|\s*Provisioned and deployed\s*\|/i.test(deployment)) {
    fail('deployment-state.md must state that Staging is provisioned and deployed');
  }
  if (!/\|\s*Production\s*\|\s*Not provisioned\s*\|/i.test(deployment)) {
    fail('deployment-state.md must state that Production is not provisioned');
  }
  const staleClaims = [
    'Staging and production are separate AWS Lightsail instances',
    'Create two independent Lightsail instances',
  ];
  for (const path of filesUnder(join(root, 'docs')).filter((file) => file.endsWith('.md'))) {
    const source = read(path);
    for (const claim of staleClaims) if (source.includes(claim)) fail(`stale deployment claim in ${relative(root, path)}: ${claim}`);
  }
}

validateCanonicalFiles();
validateRolesAndAdapters();
validateSkills();
validateWorkflows();
validateHooks();
validateMarkdownLinks();
validateSafetyAndState();

if (errors.length > 0) {
  console.error(`Agent harness validation failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log('Agent harness validation passed.');
}
