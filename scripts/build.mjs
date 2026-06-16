#!/usr/bin/env node
/**
 * Workspace build runner — bypasses `pnpm -r build` to work around
 * pnpm 11's `; echo "EXIT=$?"` wrapper, which cmd.exe (the default
 * script-shell on Windows) does not understand as a separator. The
 * wrapper is passed as literal args to tsup, which then fails with
 * "Cannot find ;,echo,...". pnpm 11.5.2 + cmd.exe has no clean
 * `script-shell` setting, so we run each workspace package's `build`
 * script directly via cmd.exe here. cmd.exe handles `&&` correctly,
 * so chained scripts like `vite build && tsup` keep working.
 *
 * Workspace layout is mirrored from pnpm-workspace.yaml (packages/*
 * apps/* and website). Update both together if packages move.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');

const workspaceGlobs = [
  ['packages', true],
  ['apps', true],
  ['website', false],
];

function discoverPackages() {
  const found = [];
  for (const [dir] of workspaceGlobs) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs)) {
      const child = join(abs, entry);
      if (!existsSync(join(child, 'package.json'))) continue;
      found.push(relative(root, child));
    }
  }
  return found;
}

function readPkgMeta(pkgDir) {
  const pkg = JSON.parse(readFileSync(join(root, pkgDir, 'package.json'), 'utf8'));
  const deps = Object.keys({
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
  }).filter((d) => d.startsWith('@wrongstack/'));
  return { dir: pkgDir, name: pkg.name, build: pkg.scripts?.build ?? null, deps };
}

// Build packages in dependency (topological) order, not the alphabetical
// order readdirSync yields. tsup's DTS step resolves a package's
// `@wrongstack/*` imports from each dependency's *emitted* dist/*.d.ts, so
// every dependency must be fully built first. Alphabetical order is unsafe:
// `cli` depends on `tools` but sorts before it, `acp` before `core`, etc. On
// a clean dist that fails outright; with a half-populated dist (stale .d.ts,
// missing .js) the build silently "succeeds" but ships an unloadable runtime
// (ERR_MODULE_NOT_FOUND). Ties are broken alphabetically for determinism.
function topoSort(metas) {
  const byName = new Map(metas.map((m) => [m.name, m]));
  const visited = new Set();
  const onStack = new Set();
  const ordered = [];
  const visit = (m) => {
    if (visited.has(m.name)) return;
    if (onStack.has(m.name)) {
      throw new Error(`Dependency cycle detected involving ${m.name}`);
    }
    onStack.add(m.name);
    const deps = m.deps
      .map((d) => byName.get(d))
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const dep of deps) visit(dep);
    onStack.delete(m.name);
    visited.add(m.name);
    ordered.push(m);
  };
  for (const m of [...metas].sort((a, b) => a.name.localeCompare(b.name))) {
    visit(m);
  }
  return ordered;
}

function runBuild(pkgDir, script) {
  // Cross-platform shell selection:
  //   - Windows: use the actual `cmd.exe` (ComSpec), because pnpm 11
  //     wraps scripts with a `; echo "EXIT=$?"` continuation that
  //     sh/bash don't understand, and pnpm 11.5.2+ has no clean way
  //     to override `script-shell` for `pnpm exec`.
  //   - POSIX: invoke `sh` directly. Using the literal string
  //     `'cmd.exe'` as a fallback (the previous default) silently
  //     produced `exit null` on ubuntu-latest runners — `cmd.exe`
  //     doesn't exist there, `spawnSync` returned ENOENT, and the
  //     `> packages/core > tsup` line in the workflow logs is the
  //     only visible artifact, making the segfault look like a
  //     memory fault when it's really "shell not found".
  const isWindows = process.platform === 'win32';
  const shell = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'sh';
  const shellArgs = isWindows ? ['/c', script] : ['-c', script];
  console.log(`\n> ${pkgDir} > ${script}`);
  // node_modules/.bin must be on PATH so tsup, tsc, etc. resolve when
  // spawned via cmd.exe / sh — the Node process inherits npm's path
  // resolution but the child shell does not. Prepend both the root bin
  // dir and the package-local bin dir (pnpm isolates bins per-package).
  const rootBin = join(root, 'node_modules', '.bin');
  const pkgBin = join(root, pkgDir, 'node_modules', '.bin');
  const pathSep = isWindows ? ';' : ':';
  const envPath = [rootBin, pkgBin, process.env.PATH || process.env.Path || ''].join(pathSep);
  const env = {
    ...process.env,
    PATH: envPath,
    Path: envPath,
    // 4 GB was enough on local + GH Actions until 2026-06, when `tsup` DTS
    // generation for `@wrongstack/core` started OOM-segfaulting in the
    // ubuntu-latest runner (`exit null`, ERR_WORKER_OUT_OF_MEMORY in
    // local repro with `--max-old-space-size=1024`). 8 GB matches the
    // GH Actions `node-options` ceiling used by `pnpm typecheck` (4 GB ×
    // 2, accounts for child workers spawned by tsup's parallel DTS
    // bundler). Lower only if you can prove a smaller cap locally — a
    // 1 GB heap triggers a hard worker kill on a fresh dist build, so
    // do not under-budget this.
    NODE_OPTIONS: '--max-old-space-size=8192',
  };
  // `serialization: 'json'` makes spawnSync round-trip child stdio as
  // JSON-encoded buffers. Functionally equivalent to the default
  // `'advanced'` mode for our purposes (we only read `result.status`),
  // but it documents the contract: child workers spawned by tsup
  // (tsc --noEmit in worker_threads) inherit this env, including
  // NODE_OPTIONS — that's how the 8 GB ceiling reaches the tsc
  // worker that was OOM-killing at 1–2 GB.
  const result = spawnSync(shell, shellArgs, {
    cwd: join(root, pkgDir),
    stdio: 'inherit',
    env,
    serialization: 'json',
  });
  if (result.status !== 0) {
    console.error(`\nBuild failed in ${pkgDir} (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
}

const pkgs = discoverPackages();
if (pkgs.length === 0) {
  console.error('No workspace packages found.');
  process.exit(1);
}

const ordered = topoSort(pkgs.map(readPkgMeta));

for (const { dir, build } of ordered) {
  if (!build) {
    console.log(`> ${dir} — no build script, skipping`);
    continue;
  }
  runBuild(dir, build);
}

console.log('\nBuild complete.');
