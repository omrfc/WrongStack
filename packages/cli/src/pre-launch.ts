import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { color } from '@wrongstack/core';
import type { ReadlineInputReader } from './input-reader.js';
import type { TerminalRenderer } from './renderer.js';
import { detectProjectFacts, renderAgentsTemplate } from './slash-commands/index.js';

export type ProjectKind =
  /** `.wrongstack/AGENTS.md` exists — fully set up. */
  | 'initialized'
  /** Has a recognizable manifest (package.json, pyproject.toml, etc.) but no AGENTS.md yet. */
  | 'project'
  /** No manifest, no AGENTS.md — probably an empty/scratch directory. */
  | 'empty';

const MANIFESTS = [
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'Makefile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'Gemfile',
];

export async function detectProjectKind(projectRoot: string): Promise<ProjectKind> {
  try {
    await fs.access(path.join(projectRoot, '.wrongstack', 'AGENTS.md'));
    return 'initialized';
  } catch {
    // not initialized
  }
  for (const m of MANIFESTS) {
    try {
      await fs.access(path.join(projectRoot, m));
      return 'project';
    } catch {
      // try next
    }
  }
  return 'empty';
}

async function scaffoldAgentsMd(projectRoot: string): Promise<string> {
  const dir = path.join(projectRoot, '.wrongstack');
  const file = path.join(dir, 'AGENTS.md');
  const facts = await detectProjectFacts(projectRoot);
  const body = renderAgentsTemplate(facts);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, body, 'utf8');
  return file;
}

/**
 * Print a one-line project status banner and, when relevant, prompt the
 * user about scaffolding `AGENTS.md` or continuing in a directory that
 * doesn't look like a project. Returns `false` if the user bailed out.
 */
export async function runProjectCheck(opts: {
  projectRoot: string;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
}): Promise<boolean> {
  const { projectRoot, renderer, reader } = opts;
  const kind = await detectProjectKind(projectRoot);

  if (kind === 'initialized') {
    renderer.write(
      `\n  ${color.green('✓')} Project initialized ${color.dim(`(${path.join(projectRoot, '.wrongstack', 'AGENTS.md')})`)}\n`,
    );
    return true;
  }

  if (kind === 'project') {
    renderer.write(
      `\n  ${color.amber('●')} Project detected ${color.dim(`(${projectRoot})`)} but ${color.bold('.wrongstack/AGENTS.md')} is missing.\n`,
    );
    const answer = (
      await reader.readLine(
        `  ${color.amber('?')} Scaffold ${color.bold('AGENTS.md')} now? ${color.dim('[y/N/q]')} `,
      )
    )
      .trim()
      .toLowerCase();
    if (answer === 'q') {
      renderer.write(color.dim('  Cancelled.\n'));
      return false;
    }
    if (answer === 'y' || answer === 'yes') {
      try {
        const file = await scaffoldAgentsMd(projectRoot);
        renderer.write(`  ${color.green('✓')} Wrote ${color.dim(file)}\n`);
      } catch (err) {
        renderer.writeError(
          `Failed to scaffold AGENTS.md: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return true;
  }

  // 'empty' — no manifest, no AGENTS.md, possibly no git
  const gitDir = path.join(projectRoot, '.git');
  let hasGit = false;
  try {
    await fs.access(gitDir);
    hasGit = true;
  } catch {
    // no git
  }

  if (!hasGit) {
    renderer.write(
      `\n  ${color.dim('○')} ${color.dim(`No project manifest in ${projectRoot} — running in a scratch directory.`)}\n`,
    );
    const answer = (
      await reader.readLine(
        `  ${color.amber('?')} No git repo found. ${color.bold('Initialize git?')} ${color.dim('[y/N/q]')} `,
      )
    )
      .trim()
      .toLowerCase();
    if (answer === 'q') {
      renderer.write(color.dim('  Cancelled.\n'));
      return false;
    }
    if (answer === 'y' || answer === 'yes') {
      try {
        const { spawn } = await import('node:child_process');
        await new Promise<void>((resolve, reject) => {
          const child = spawn('git', ['init'], { cwd: projectRoot });
          child.on('error', reject);
          child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git init failed with ${code}`))));
        });
        renderer.write(`  ${color.green('✓')} Git repository initialized\n`);
      } catch (err) {
        renderer.writeError(`git init failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  } else {
    renderer.write(
      `\n  ${color.dim('○')} ${color.dim(`No project manifest in ${projectRoot} — running in a scratch directory.`)}\n`,
    );
  }

  const answer = (
    await reader.readLine(`  ${color.amber('?')} Continue anyway? ${color.dim('[Y/n/q]')} `)
  )
    .trim()
    .toLowerCase();
  if (answer === 'q' || answer === 'n' || answer === 'no') {
    renderer.write(color.dim('  Cancelled.\n'));
    return false;
  }
  return true;
}

export interface LaunchModeChoices {
  /** TUI or plain REPL. */
  mode: 'tui' | 'repl';
  /** Auto-approve every tool call (no permission prompts). */
  yolo: boolean;
  /** Start with Director mode on (fleet manifest + scratchpad enabled). */
  director: boolean;
  /** Initial autonomy mode. 'off' = stops after each turn; 'auto' = self-driving. */
  autonomy: 'off' | 'auto';
}

/**
 * Thrown by runLaunchPrompts when the user presses q to cancel.
 * Caught by boot.ts so it can exit cleanly without process.exit().
 */
export class LaunchAbortedError extends Error {
  readonly exitCode = 0;
  constructor() {
    super('Launch cancelled by user');
    this.name = 'LaunchAbortedError';
  }
}

/**
 * Ask for interactive mode (TUI vs REPL), YOLO, Director, and Autonomy.
 * Each prompt is skipped when the corresponding option is pinned via CLI
 * flag. Returns the resolved set.
 *
 * @throws LaunchAbortedError when the user presses q to cancel.
 */
export async function runLaunchPrompts(opts: {
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  modePinned?: 'tui' | 'repl';
  yoloPinned?: boolean;
  directorPinned?: boolean;
  autonomyPinned?: 'off' | 'auto';
}): Promise<LaunchModeChoices> {
  const { renderer, reader, modePinned, yoloPinned, directorPinned, autonomyPinned } = opts;

  let mode: 'tui' | 'repl';
  if (modePinned) {
    mode = modePinned;
  } else {
    const answer = (
      await reader.readLine(
        `\n  ${color.amber('?')} Interactive mode: ${color.bold('T')}UI / ${color.bold('R')}EPL ${color.dim('[T/r/q]')} `,
      )
    )
      .trim()
      .toLowerCase();
    if (answer === 'q') {
      renderer.write(color.dim('  Goodbye!\n'));
      throw new LaunchAbortedError();
    }
    mode = answer === 'r' || answer === 'repl' ? 'repl' : 'tui';
  }

  let yolo: boolean;
  if (yoloPinned !== undefined) {
    yolo = yoloPinned;
  } else {
    const answer = (
      await reader.readLine(
        `  ${color.amber('?')} YOLO mode ${color.dim('(auto-approve every tool call)')} ${color.dim('[Y/n/q]')} `,
      )
    )
      .trim()
      .toLowerCase();
    if (answer === 'q') {
      renderer.write(color.dim('  Goodbye!\n'));
      throw new LaunchAbortedError();
    }
    yolo = answer !== 'n' && answer !== 'no';
  }

  let director: boolean;
  if (directorPinned !== undefined) {
    director = directorPinned;
  } else {
    const answer = (
      await reader.readLine(
        `  ${color.amber('?')} Director mode ${color.dim('(fleet manifest + multi-agent orchestration)')} ${color.dim('[Y/n/q]')} `,
      )
    )
      .trim()
      .toLowerCase();
    if (answer === 'q') {
      renderer.write(color.dim('  Goodbye!\n'));
      throw new LaunchAbortedError();
    }
    director = answer !== 'n' && answer !== 'no';
  }

  let autonomy: 'off' | 'auto';
  if (autonomyPinned !== undefined) {
    autonomy = autonomyPinned;
  } else {
    const answer = (
      await reader.readLine(
        `  ${color.amber('?')} Autonomy mode ${color.dim('(auto-continue — agent picks next step)')} ${color.dim('[Y/n/q]')} `,
      )
    )
      .trim()
      .toLowerCase();
    if (answer === 'q') {
      renderer.write(color.dim('  Goodbye!\n'));
      throw new LaunchAbortedError();
    }
    autonomy = answer !== 'n' && answer !== 'no' ? 'auto' : 'off';
  }

  const badges: string[] = [];
  if (yolo) badges.push(color.yellow('YOLO'));
  if (director) badges.push(color.cyan('DIRECTOR'));
  if (autonomy !== 'off') badges.push(color.magenta(`AUTONOMY:${autonomy.toUpperCase()}`));
  const badgeStr = badges.length > 0 ? ` (${badges.join(' · ')})` : '';
  renderer.write(
    `\n  ${color.green('▶')} Launching in ${color.bold(mode.toUpperCase())} mode${badgeStr}\n\n`,
  );

  return { mode, yolo, director, autonomy };
}
