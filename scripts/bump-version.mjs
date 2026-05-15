#!/usr/bin/env node
/**
 * Lockstep version bumper for the WrongStack workspace.
 *
 * Bumps every package.json that is part of the publishable set (root +
 * `packages/*`) by the same amount, so a single `pnpm release` cuts a
 * coherent release. Mixed-version monorepos work but make the changelog
 * harder to reason about — keep them aligned unless there's a strong
 * reason not to.
 *
 * Usage:
 *   node scripts/bump-version.mjs patch
 *   node scripts/bump-version.mjs minor
 *   node scripts/bump-version.mjs major
 *   node scripts/bump-version.mjs set <version>
 *
 * Workspace cross-deps stay on `workspace:*` — `pnpm publish` rewrites them
 * to the actual version at publish time, so we don't touch them here.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const FILES = [
  'package.json',
  'packages/core/package.json',
  'packages/cli/package.json',
  'packages/mcp/package.json',
  'packages/providers/package.json',
  'packages/tui/package.json',
  'packages/tools/package.json',
  'packages/plug-lsp/package.json',
  'packages/webui/package.json',
  'apps/wrongstack/package.json',
];

const [, , mode, arg] = process.argv;

function fail(msg) {
  console.error(`bump-version: ${msg}`);
  process.exit(1);
}

function bump(current, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(current);
  if (!m) fail(`could not parse version "${current}"`);
  let [, major, minor, patch] = m;
  major = Number(major);
  minor = Number(minor);
  patch = Number(patch);
  switch (kind) {
    case 'patch':
      patch++;
      break;
    case 'minor':
      minor++;
      patch = 0;
      break;
    case 'major':
      major++;
      minor = 0;
      patch = 0;
      break;
    default:
      fail(`unknown bump kind "${kind}"`);
  }
  return `${major}.${minor}.${patch}`;
}

function compareSemver(a, b) {
  const pa = a.split(/[.-]/).map((x) => (isNaN(+x) ? x : +x));
  const pb = b.split(/[.-]/).map((x) => (isNaN(+x) ? x : +x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

if (!['patch', 'minor', 'major', 'set'].includes(mode)) {
  fail(`expected one of: patch | minor | major | set <version>`);
}
if (mode === 'set' && !arg) fail('`set` requires a version argument');

let highest = '0.0.0';
for (const file of FILES) {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, file), 'utf8'));
  if (compareSemver(pkg.version, highest) > 0) highest = pkg.version;
}

const target = mode === 'set' ? arg : bump(highest, mode);

console.log(`Bumping all workspace packages to ${target} (was ${highest})`);

for (const file of FILES) {
  const full = resolve(ROOT, file);
  const pkg = JSON.parse(readFileSync(full, 'utf8'));
  const before = pkg.version;
  if (before === target) {
    console.log(`  ${file}: already at ${target}`);
    continue;
  }
  pkg.version = target;
  writeFileSync(full, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`  ${file}: ${before} -> ${target}`);
}

console.log('');
console.log('Next steps:');
console.log('  pnpm release:check       # typecheck + test + build');
console.log('  pnpm release:dry         # see exactly what would publish');
console.log('  pnpm release             # publish to npm');
console.log('');
console.log(`Then: git commit -am 'release: ${target}' && git tag v${target} && git push --follow-tags`);
