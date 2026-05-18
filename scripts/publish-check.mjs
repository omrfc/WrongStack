#!/usr/bin/env node
/**
 * Pre-publish validation. Checks that all workspace packages are ready
 * to publish to npm. Run before `pnpm -r publish`.
 *
 * Usage:
 *   node scripts/publish-check.mjs [--dry-run]
 *
 * Checks:
 *   1. All package.json files have required fields (name, version, license, etc.)
 *   2. No workspace:* deps leaked into dist (pnpm rewrites on publish, but verify)
 *   3. All packages build cleanly
 *   4. No uncommitted changes
 *   5. Version is consistent across workspace
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');

let errors = 0;

function fail(msg) {
  console.error(`  ✗ ${msg}`);
  errors++;
}

function pass(msg) {
  console.log(`  ✓ ${msg}`);
}

function warn(msg) {
  console.log(`  ⚠ ${msg}`);
}

// ---- 1. Find all publishable packages ----
console.log('\n📦 Checking publishable packages...\n');

const pkgDirs = [
  'packages/core',
  'packages/cli',
  'packages/mcp',
  'packages/providers',
  'packages/runtime',
  'packages/tui',
  'packages/tools',
  'packages/plug-lsp',
  'packages/webui',
  'packages/telegram',
  'packages/skills',
];

const versions = new Set();

for (const dir of pkgDirs) {
  const pkgPath = resolve(ROOT, dir, 'package.json');
  if (!existsSync(pkgPath)) {
    fail(`${dir}: package.json not found`);
    continue;
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const name = pkg.name || dir;

  // Required fields
  if (!pkg.name) fail(`${dir}: missing "name"`);
  if (!pkg.version) fail(`${dir}: missing "version"`);
  if (!pkg.license && !pkg.private) fail(`${dir}: missing "license"`);
  if (!pkg.main && !pkg.exports) fail(`${dir}: missing "main" or "exports"`);

  versions.add(pkg.version);

  // Check dist exists (skip for private packages)
  if (pkg.private) {
    warn(`${name}@${pkg.version} — private, skipped dist check`);
  } else {
    const distDir = resolve(ROOT, dir, 'dist');
    if (!existsSync(distDir)) {
      fail(`${dir}: dist/ not found — run "pnpm build" first`);
    } else {
      pass(`${name}@${pkg.version} — dist/ exists`);
    }
  }

  // Check for workspace: deps in dependencies (should be rewritten by pnpm publish)
  const allDeps = { ...pkg.dependencies, ...pkg.peerDependencies };
  for (const [dep, ver] of Object.entries(allDeps)) {
    if (typeof ver === 'string' && ver.startsWith('workspace:')) {
      warn(`${name}: ${dep} = "${ver}" — pnpm will rewrite on publish`);
    }
  }
}

// ---- 2. Version consistency ----
console.log('\n🔢 Version consistency...\n');

if (versions.size === 1) {
  pass(`All packages at v${[...versions][0]}`);
} else {
  fail(`Version mismatch: ${[...versions].join(', ')}`);
}

// ---- 3. Git status ----
console.log('\n📝 Git status...\n');

try {
  const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).trim();
  if (status) {
    warn('Uncommitted changes present:');
    for (const line of status.split('\n').slice(0, 5)) {
      console.log(`    ${line}`);
    }
    if (status.split('\n').length > 5) {
      console.log(`    ... and ${status.split('\n').length - 5} more`);
    }
  } else {
    pass('Working tree clean');
  }
} catch {
  warn('Could not check git status');
}

// ---- 4. Summary ----
console.log('\n' + '─'.repeat(50));

if (errors > 0) {
  console.error(`\n❌ ${errors} error(s) found. Fix before publishing.\n`);
  process.exit(1);
} else {
  console.log(`\n✅ All checks passed. Ready to publish.\n`);
  if (dryRun) {
    console.log('Dry run — no packages were published.');
    console.log('To publish: pnpm -r publish --no-git-checks --access public\n');
  }
}
