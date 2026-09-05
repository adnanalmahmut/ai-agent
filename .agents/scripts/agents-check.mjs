#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const errors = [];

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

/**
 * Only files something else silently depends on: the two entry points the host
 * tools discover, the scripts named by hook configuration, those configs, and
 * the deployment record this script itself reads. Prose files are not listed —
 * a document that goes missing while something still points at it is caught by
 * link validation, which needs no registry to maintain.
 */
function validateCanonicalFiles() {
  const required = [
    'AGENTS.md',
    'CLAUDE.md',
    '.agents/hooks/policy.mjs',
    '.agents/hooks/pre-tool.mjs',
    '.agents/hooks/stop-check.mjs',
    '.agents/scripts/resume-task.mjs',
    '.codex/hooks.json',
    '.claude/settings.json',
    'docs/deployment-state.md',
  ];
  for (const file of required) if (!exists(join(root, file))) fail(`missing canonical file: ${file}`);

  // Without this exact import Claude Code silently loses every project rule.
  const firstLine = read(join(root, 'CLAUDE.md')).split(/\r?\n/, 1)[0];
  if (firstLine !== '@AGENTS.md') fail('CLAUDE.md must begin with the exact @AGENTS.md import');
}

/**
 * Adapters are dangling-pointer risks, not style risks. What breaks concretely
 * is an adapter that names a canonical role file which does not exist, or a
 * canonical role that no adapter exposes — so both directions are checked
 * against the filesystem. Which roles exist is the repository's business; adding
 * one must not require editing this file.
 */
function validateRolesAndAdapters() {
  const roles = sortedNames(join(root, '.agents/roles'), '.md');
  if (roles.length === 0) fail('no canonical role contracts found under .agents/roles');

  const adapters = [
    ['.codex/agents', '.toml'],
    ['.claude/agents', '.md'],
  ];
  for (const [directory, extension] of adapters) {
    const present = sortedNames(join(root, directory), extension);
    for (const role of roles) {
      if (!present.includes(role)) fail(`${directory} has no adapter for canonical role ${role}`);
    }

    for (const name of present) {
      const path = join(root, directory, `${name}${extension}`);
      const source = read(path);
      const target = `.agents/roles/${name}.md`;
      if (!exists(join(root, target))) fail(`${relative(root, path)} adapts ${name}, which has no canonical role file`);
      if (!source.includes(target)) fail(`${relative(root, path)} does not route to ${target}`);
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
    fail('missing Claude skill path file: .claude/skills');
    return;
  }
  const stat = lstatSync(claudeSkills);
  let targetPath = '';
  if (stat.isSymbolicLink()) {
    targetPath = readlinkSync(claudeSkills);
  } else if (stat.isFile()) {
    targetPath = readFileSync(claudeSkills, 'utf8').trim();
  } else {
    fail('.claude/skills must be a path file or symlink indicating ../.agents/skills');
    return;
  }
  if (targetPath !== '../.agents/skills') {
    fail(`.claude/skills must indicate ../.agents/skills, got: ${targetPath}`);
  }

  for (const directory of ['.codex', '.claude']) {
    for (const file of filesUnder(join(root, directory))) {
      if (file.endsWith('SKILL.md') && !lstatSync(dirname(file)).isSymbolicLink()) {
        fail(`copied tool-specific skill found: ${relative(root, file)}`);
      }
    }
  }
}

function validateHooks() {
  const configs = {};
  for (const config of ['.codex/hooks.json', '.claude/settings.json']) {
    try {
      configs[config] = JSON.parse(read(join(root, config)));
    } catch (error) {
      fail(`${config} is invalid JSON: ${error.message}`);
    }
  }

  for (const script of [
    '.agents/hooks/policy.mjs',
    '.agents/hooks/pre-tool.mjs',
    '.agents/hooks/stop-check.mjs',
    '.agents/scripts/agents-check.mjs',
    '.agents/scripts/resume-task.mjs',
  ]) {
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
