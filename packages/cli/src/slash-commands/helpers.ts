import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core';
import { color, estimateMessageTokens } from '@wrongstack/core';

export interface ProjectFacts {
  build?: string | undefined;
  test?: string | undefined;
  lint?: string | undefined;
  run?: string | undefined;
  hints: string[];
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function detectPackageManager(root: string, declared?: string): Promise<string> {
  if (declared) {
    const name = declared.split('@')[0];
    if (name) return name;
  }
  if (await pathExists(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await pathExists(path.join(root, 'bun.lockb'))) return 'bun';
  if (await pathExists(path.join(root, 'bun.lock'))) return 'bun';
  if (await pathExists(path.join(root, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function hasUsableScript(scripts: Record<string, string>, name: string): boolean {
  const script = scripts[name];
  if (typeof script !== 'string' || script.trim() === '') return false;
  if (name === 'test' && /no test specified/i.test(script)) return false;
  return true;
}

function parseMakeTargets(makefile: string): Set<string> {
  const targets = new Set<string>();
  for (const line of makefile.split(/\r?\n/)) {
    if (line.startsWith('\t') || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Za-z0-9_.-]+)\s*:(?![=])/.exec(line);
    if (match?.[1]) targets.add(match[1]);
  }
  return targets;
}

export async function detectProjectFacts(root: string): Promise<ProjectFacts> {
  const facts: ProjectFacts = { hints: [] };
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
      packageManager?: string | undefined;
    };
    const scripts = pkg.scripts ?? {};
    const pm = await detectPackageManager(root, pkg.packageManager);
    if (hasUsableScript(scripts, 'build')) facts.build = `${pm} run build`;
    if (hasUsableScript(scripts, 'test')) facts.test = `${pm} test`;
    if (hasUsableScript(scripts, 'lint')) facts.lint = `${pm} run lint`;
    const runScript = ['dev', 'start', 'serve', 'preview'].find((name) =>
      hasUsableScript(scripts, name),
    );
    if (runScript) facts.run = `${pm} run ${runScript}`;
    facts.hints.push(Object.keys(scripts).length > 0 ? 'package.json scripts' : 'package.json');
  } catch {
    /* not node */
  }
  try {
    if (!(await pathExists(path.join(root, 'pyproject.toml')))) throw new Error('not python');
    facts.test ??= 'pytest';
    facts.lint ??= 'ruff check .';
    facts.hints.push('pyproject.toml');
  } catch {
    /* not python */
  }
  try {
    if (!(await pathExists(path.join(root, 'go.mod')))) throw new Error('not go');
    facts.build ??= 'go build ./...';
    facts.test ??= 'go test ./...';
    facts.run ??= 'go run .';
    facts.hints.push('go.mod');
  } catch {
    /* not go */
  }
  try {
    if (!(await pathExists(path.join(root, 'Cargo.toml')))) throw new Error('not rust');
    facts.build ??= 'cargo build';
    facts.test ??= 'cargo test';
    facts.lint ??= 'cargo clippy';
    facts.run ??= 'cargo run';
    facts.hints.push('Cargo.toml');
  } catch {
    /* not rust */
  }
  try {
    const makefile = await fs.readFile(path.join(root, 'Makefile'), 'utf8');
    const targets = parseMakeTargets(makefile);
    facts.build ??= targets.has('build') ? 'make build' : 'make';
    if (targets.has('test')) facts.test ??= 'make test';
    if (targets.has('lint')) facts.lint ??= 'make lint';
    const runTarget = ['run', 'dev', 'start', 'serve'].find((name) => targets.has(name));
    if (runTarget) facts.run ??= `make ${runTarget}`;
    facts.hints.push('Makefile');
  } catch {
    /* no make */
  }
  return facts;
}

export function renderAgentsTemplate(f: ProjectFacts): string {
  const cmd = (s?: string) => (s ? `\`${s}\`` : '_TODO_');
  const hints = f.hints.length > 0 ? `\n\n> Auto-detected: ${f.hints.join(', ')}` : '';

  return `# AGENTS.md

> **DO NOT DELETE THIS FILE.** It is loaded into WrongStack's system prompt as
> persistent project context. Previous content here may contain decisions,
> architecture notes, domain knowledge, or verification history that should be
> preserved. Merge additions rather than replacing.

## Project brief

- **Purpose:** _What does this project do and why does it exist?_
- **Primary users:** _Who uses it: developers, operators, customers, internal systems?_
- **Runtime / deployment:** _CLI, server, browser, worker, library, package?_${hints}

## How to work safely

- _Project-specific rules the agent should always follow._
- _Files, generated artifacts, migrations, or config the agent should not edit without asking._
- _Preferred style or architecture choices not obvious from the code._
- _Known fragile areas or historical bugs that deserve extra caution._

## Commands

| Command | Script |
|---------|--------|
| Build | ${cmd(f.build)} |
| Test | ${cmd(f.test)} |
| Lint | ${cmd(f.lint)} |
| Run locally | ${cmd(f.run)} |

## Key files and entry points

| File / directory | Role |
|---|---|
| _src/_ | _Main source entry point(s)_ |
| _tests/_ | _Test root or convention_ |
| _docs/_ | _Architecture, runbooks, design notes_ |
| _scripts/_ | _Automation scripts (CI, release, install, etc.)_ |

## Architecture notes

_Summarize the important modules, data flow, boundaries, and ownership rules.
Mention anything a newcomer might misread or that looks unusual but is intentional._

### Dependency layers

_Describe the key dependency direction or layered structure, e.g.: "core has no
runtime deps; cli assembles everything above it."_

### Extension points

_Plugin, MCP, extension hooks, custom tools — what's wired up and how._

## Domain knowledge

_Business rules, acronyms, invariants, external services, and notes where the
code looks unusual but is intentional. E.g.: "IDs are ULIDs, not UUIDs", "the
\`draft\` flag means uncommitted billing metadata", "MCP servers are restarted
on disconnect with exponential backoff, up to 3 attempts"._

## Verification checklist

- _What should be run after code changes?_
- _What manual smoke test proves the common path still works?_
- _What failure modes deserve extra attention?_
- _Any known flaky tests or environment-dependent behavior?_

## Useful pointers

- _Docs, dashboards, runbooks, issue trackers, design notes, owner contacts._
- _Related projects or repositories._`;

}

export function countTurnPairs(messages: Context['messages']): number {
  let count = 0;
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'assistant') count++;
  }
  return Math.floor(count / 2);
}

export function countToolUses(messages: Context['messages']): number {
  let count = 0;
  for (const m of messages) {
    if (Array.isArray(m.content)) count += m.content.filter((b) => b.type === 'tool_use').length;
  }
  return count;
}

export function countToolResults(messages: Context['messages']): number {
  let count = 0;
  for (const m of messages) {
    if (Array.isArray(m.content)) count += m.content.filter((b) => b.type === 'tool_result').length;
  }
  return count;
}

/** Messages-only token estimate. Delegates to the canonical shared estimator so
 *  `/context` shows the same number compaction and the context bar work with. */
export function estimateTokens(messages: Context['messages']): number {
  return estimateMessageTokens(messages);
}

export function statusIcon(status: string): string {
  if (status === 'healthy') return color.green('\u25cf');
  if (status === 'degraded') return color.yellow('\u25cf');
  return color.red('\u25cf');
}
