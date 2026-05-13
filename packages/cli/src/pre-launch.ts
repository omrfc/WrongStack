import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { color } from '@wrongstack/core';
import type { TerminalRenderer } from './renderer.js';
import type { ReadlineInputReader } from './input-reader.js';
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
        `  ${color.amber('?')} Scaffold ${color.bold('AGENTS.md')} now? ${color.dim('[y/N]')} `,
      )
    ).trim().toLowerCase();
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

  // 'empty' — no manifest, no AGENTS.md
  renderer.write(
    `\n  ${color.dim('○')} ${color.dim(`No project manifest in ${projectRoot} — running in a scratch directory.`)}\n`,
  );
  const answer = (
    await reader.readLine(
      `  ${color.amber('?')} Continue anyway? ${color.dim('[Y/n]')} `,
    )
  ).trim().toLowerCase();
  if (answer === 'n' || answer === 'no') {
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
}

/**
 * Ask for interactive mode (TUI vs REPL) and YOLO. Either prompt is
 * skipped when the corresponding CLI flag was already pinned. Returns
 * the resolved pair.
 */
export async function runLaunchPrompts(opts: {
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  modePinned?: 'tui' | 'repl';
  yoloPinned?: boolean;
}): Promise<LaunchModeChoices> {
  const { renderer, reader, modePinned, yoloPinned } = opts;

  let mode: 'tui' | 'repl';
  if (modePinned) {
    mode = modePinned;
  } else {
    const answer = (
      await reader.readLine(
        `\n  ${color.amber('?')} Interactive mode: ${color.bold('T')}UI / ${color.bold('R')}EPL ${color.dim('[T/r]')} `,
      )
    ).trim().toLowerCase();
    mode = answer === 'r' || answer === 'repl' ? 'repl' : 'tui';
  }

  let yolo: boolean;
  if (yoloPinned !== undefined) {
    yolo = yoloPinned;
  } else {
    const answer = (
      await reader.readLine(
        `  ${color.amber('?')} YOLO mode ${color.dim('(auto-approve every tool call)')} ${color.dim('[y/N]')} `,
      )
    ).trim().toLowerCase();
    yolo = answer === 'y' || answer === 'yes';
  }

  renderer.write(
    `\n  ${color.green('▶')} Launching in ${color.bold(mode.toUpperCase())} mode${yolo ? color.yellow(' (YOLO)') : ''}\n\n`,
  );

  return { mode, yolo };
}
