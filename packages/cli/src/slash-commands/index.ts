import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  SlashCommand,
  SlashCommandRegistry,
  ToolRegistry,
  Compactor,
  SessionStore,
  SkillLoader,
  TokenCounter,
  Renderer,
  Context,
  MemoryStore,
} from '@wrongstack/core';
import { color } from '@wrongstack/core';

export interface SlashCommandContext {
  registry: SlashCommandRegistry;
  toolRegistry: ToolRegistry;
  compactor?: Compactor;
  sessionStore?: SessionStore;
  skillLoader?: SkillLoader;
  tokenCounter: TokenCounter;
  renderer: Renderer;
  memoryStore?: MemoryStore;
  context?: Context;
  onExit?: () => void;
  onClear?: () => void;
  onSwitchProvider?: (name: string) => void;
  onSwitchModel?: (name: string) => void;
  onDiag?: () => void;
  onStats?: () => void;
}

export function buildBuiltinSlashCommands(opts: SlashCommandContext): SlashCommand[] {
  return [
    helpCommand(opts),
    initCommand(opts),
    clearCommand(opts),
    compactCommand(opts),
    contextCommand(opts),
    usageCommand(opts),
    toolsCommand(opts),
    skillCommand(opts),
    useCommand(opts),
    modelCommand(opts),
    diagCommand(opts),
    statsCommand(opts),
    saveCommand(opts),
    loadCommand(opts),
    exitCommand(opts),
  ];
}

/**
 * Bootstrap a `.wrongstack/AGENTS.md` in the current project. We try to
 * sniff the repo for common build/test commands so the file starts with
 * useful content instead of a blank template — the user is meant to edit
 * it, but those defaults remove the friction of staring at a blank page.
 */
function initCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'init',
    description: 'Scaffold .wrongstack/AGENTS.md in the current project.',
    async run(args, ctx) {
      const force = args.trim() === '--force';
      const dir = path.join(ctx.projectRoot, '.wrongstack');
      const file = path.join(dir, 'AGENTS.md');
      try {
        await fs.access(file);
        if (!force) {
          const msg = `AGENTS.md already exists at ${file}. Use "/init --force" to overwrite.`;
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
      } catch {
        // doesn't exist — proceed
      }
      const detected = await detectProjectFacts(ctx.projectRoot);
      const body = renderAgentsTemplate(detected);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, body, 'utf8');
      if (detected.hints.length > 0) {
        const msg = `Wrote ${file}\nPre-filled: ${detected.hints.join(', ')}. Edit the file to add anything else worth remembering.`;
        opts.renderer.writeInfo(`Wrote ${file}`);
        opts.renderer.writeInfo(`Pre-filled: ${detected.hints.join(', ')}. Edit the file to add anything else worth remembering.`);
        return { message: msg };
      } else {
        const msg = `Wrote ${file}\nNo project type auto-detected. Edit the file to add build/test commands and conventions.`;
        opts.renderer.writeInfo(`Wrote ${file}`);
        return { message: msg };
      }
    },
  };
}

export interface ProjectFacts {
  build?: string;
  test?: string;
  lint?: string;
  run?: string;
  hints: string[];
}

export async function detectProjectFacts(root: string): Promise<ProjectFacts> {
  const facts: ProjectFacts = { hints: [] };
  // package.json
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
      packageManager?: string;
    };
    const scripts = pkg.scripts ?? {};
    const pm = (pkg.packageManager ?? 'npm').split('@')[0] ?? 'npm';
    if (scripts['build']) facts.build = `${pm} run build`;
    if (scripts['test']) facts.test = `${pm} test`;
    if (scripts['lint']) facts.lint = `${pm} run lint`;
    if (scripts['dev'] ?? scripts['start']) facts.run = `${pm} run ${scripts['dev'] ? 'dev' : 'start'}`;
    facts.hints.push('package.json scripts');
  } catch {
    // not node
  }
  // pyproject.toml
  try {
    await fs.access(path.join(root, 'pyproject.toml'));
    facts.test ??= 'pytest';
    facts.lint ??= 'ruff check .';
    facts.hints.push('pyproject.toml');
  } catch {
    // not python
  }
  // go.mod
  try {
    await fs.access(path.join(root, 'go.mod'));
    facts.build ??= 'go build ./...';
    facts.test ??= 'go test ./...';
    facts.hints.push('go.mod');
  } catch {
    // not go
  }
  // Cargo.toml
  try {
    await fs.access(path.join(root, 'Cargo.toml'));
    facts.build ??= 'cargo build';
    facts.test ??= 'cargo test';
    facts.hints.push('Cargo.toml');
  } catch {
    // not rust
  }
  // Makefile — last resort
  try {
    await fs.access(path.join(root, 'Makefile'));
    facts.build ??= 'make';
    facts.test ??= 'make test';
    facts.hints.push('Makefile');
  } catch {
    // no make
  }
  return facts;
}

export function renderAgentsTemplate(f: ProjectFacts): string {
  const cmd = (s?: string) => (s ? `\`${s}\`` : '_TODO_');
  return `# AGENTS.md

Project notes for WrongStack. Committed to the repo so every contributor
(human or agent) starts with the same context. Edit freely.

## What this project is

_One paragraph: what does this codebase do, who runs it, what's the
deployment target?_

## How to work on it

- **Build:** ${cmd(f.build)}
- **Test:** ${cmd(f.test)}
- **Lint:** ${cmd(f.lint)}
- **Run locally:** ${cmd(f.run)}

## Conventions

_What style choices matter here? Filenames, module layout, naming, error
handling, log format. Anything a stranger would get wrong._

## Domain knowledge

_Acronyms, business rules, foot-guns, "this looks weird but it's
intentional because…"._

## Pointers

_Where to look for: routing, database migrations, feature flags,
on-call runbooks, dashboards._
`;
}

function diagCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'diag',
    description: 'Show runtime diagnostics (provider, tokens, tools, MCP).',
    async run() {
      if (opts.onDiag) {
        opts.onDiag();
        return { message: 'diag' };
      } else {
        return { message: 'Diag not available in this context.' };
      }
    },
  };
}

function statsCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'stats',
    description: 'Show session report: tokens, requests, tools, files, cost.',
    async run() {
      if (opts.onStats) {
        opts.onStats();
        return { message: 'stats' };
      } else {
        return { message: 'Stats not available in this context.' };
      }
    },
  };
}

function helpCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'help',
    description: 'Show available slash commands.',
    async run() {
      const lines = ['Available slash commands:'];
      for (const { cmd, owner, fullName } of opts.registry.listWithOwner()) {
        const isBuiltin = owner === 'core';
        // Builtins: no prefix. Plugins: prefix shown.
        const prefix = isBuiltin ? '' : `${owner}:`;
        const aliases = cmd.aliases
          ? cmd.aliases.map((a) => `/${prefix}${a}`).join(', ')
          : '';
        const aliasStr = aliases ? ` (${aliases})` : '';
        lines.push(`  /${prefix}${cmd.name}${aliasStr} — ${cmd.description}`);
      }
      return { message: lines.join('\n') };
    },
  };
}

function clearCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'clear',
    description: 'Reset the session and start a new one.',
    async run(_args, ctx) {
      // Clear context: messages, todos, readFiles, fileMtimes
      if (ctx) {
        ctx.messages = [];
        ctx.todos = [];
        ctx.readFiles.clear();
        ctx.fileMtimes.clear();
        ctx.meta = {};
      }
      // Clear memory store (all scopes)
      await opts.memoryStore?.clear();
      opts.onClear?.();
      opts.renderer.clear();
      const msg = 'Session cleared (context, memory, and history reset).';
      opts.renderer.writeInfo(msg);
      return { message: msg };
    },
  };
}

function contextCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'context',
    aliases: ['ctx'],
    description: 'Show context window summary.',
    async run(args, ctx) {
      const messages = ctx.messages;
      const detailed = args.trim() === 'detail';

      const pairCount = countTurnPairs(messages);
      const estimatedTokens = estimateTokens(messages);
      const toolUseCount = countToolUses(messages);
      const toolResultCount = countToolResults(messages);

      const lines = [
        `${color.bold('Context Window')}`,
        `  messages:    ${messages.length} total (${pairCount} user+assistant pairs)`,
        `  tokens (≈):  ${estimatedTokens.toLocaleString()} (chars ÷ 4 estimate)`,
        `  system prompt: ${ctx.systemPrompt.length} block${ctx.systemPrompt.length !== 1 ? 's' : ''}`,
        `  tools:       ${toolUseCount} calls made, ${toolResultCount} results in history`,
        `  read files:  ${ctx.readFiles.size} files`,
        `  todos:       ${ctx.todos.filter((t) => t.status === 'in_progress').length} in_progress / ${ctx.todos.filter((t) => t.status === 'pending').length} pending / ${ctx.todos.filter((t) => t.status === 'completed').length} completed`,
      ];

      if (detailed) {
        lines.push(`  model:       ${ctx.model}`);
        lines.push(`  cwd:         ${ctx.cwd}`);
        lines.push(`  projectRoot: ${ctx.projectRoot}`);
        lines.push(`  file mtimes: ${ctx.fileMtimes.size} tracked`);
        if (ctx.readFiles.size > 0) {
          lines.push(`  file list:   ${[...ctx.readFiles].join(', ')}`);
        }
      }

      const msg = lines.join('\n');
      opts.renderer.write(`${msg}\n`);
      return { message: msg };
    },
  };
}

function countTurnPairs(messages: Context['messages']): number {
  let count = 0;
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'assistant') count++;
  }
  return Math.floor(count / 2);
}

function countToolUses(messages: Context['messages']): number {
  let count = 0;
  for (const m of messages) {
    const content = m.content;
    if (Array.isArray(content)) {
      count += content.filter((b) => b.type === 'tool_use').length;
    }
  }
  return count;
}

function countToolResults(messages: Context['messages']): number {
  let count = 0;
  for (const m of messages) {
    const content = m.content;
    if (Array.isArray(content)) {
      count += content.filter((b) => b.type === 'tool_result').length;
    }
  }
  return count;
}

function estimateTokens(messages: Context['messages']): number {
  let total = 0;
  for (const m of messages) {
    const content = m.content;
    if (typeof content === 'string') {
      total += Math.ceil(content.length / 4);
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'text') total += Math.ceil(b.text.length / 4);
        else if (b.type === 'tool_use' || b.type === 'tool_result') {
          total += Math.ceil(JSON.stringify(b).length / 4);
        }
      }
    }
  }
  return total;
}

function compactCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'compact',
    description: 'Compact the context window.',
    async run(args, ctx) {
      if (!opts.compactor) {
        const msg = 'No compactor configured.';
        opts.renderer.writeWarning(msg);
        return { message: msg };
      }
      const aggressive = args.trim() === 'aggressive';
      const report = await opts.compactor.compact(ctx, { aggressive });
      const msg =
        `Compaction: ${report.before} → ${report.after} tokens (${report.reductions
          .map((r) => `${r.phase}: ${r.saved}`)
          .join(', ')})`;
      opts.renderer.writeInfo(msg);
      return { message: msg };
    },
  };
}

function usageCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'usage',
    aliases: ['cost'],
    description: 'Show token usage and estimated cost.',
    async run() {
      const total = opts.tokenCounter.total();
      const cost = opts.tokenCounter.estimateCost();
      const msg =
        `${color.bold('Usage')}\n` +
          `  input:       ${total.input}\n` +
          `  output:      ${total.output}\n` +
          `  cache read:  ${total.cacheRead ?? 0}\n` +
          `  cache write: ${total.cacheWrite ?? 0}\n` +
          `  cost:        $${cost.total.toFixed(4)} (input $${cost.input.toFixed(4)} / output $${cost.output.toFixed(4)})\n`;
      opts.renderer.write(msg);
      return { message: msg };
    },
  };
}

function toolsCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'tools',
    description: 'List registered tools.',
    async run() {
      const all = opts.toolRegistry.listWithOwner();
      const lines = all.map(({ tool, owner }) => {
        return `  ${tool.name.padEnd(28)} ${color.dim(`[${owner}]`)} ${tool.mutating ? color.yellow('mut') : color.cyan('ro')} ${color.dim(tool.permission)}`;
      });
      const msg = `${color.bold('Tools')} (${all.length}):\n${lines.join('\n')}\n`;
      opts.renderer.write(msg);
      return { message: msg };
    },
  };
}

function skillCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'skill',
    description: 'Show a skill manifest or list skills.',
    async run(args) {
      if (!opts.skillLoader) {
        const msg = 'No skill loader configured.';
        return { message: msg };
      }
      if (!args.trim()) {
        const list = await opts.skillLoader.list();
        if (list.length === 0) {
          const msg = 'No skills found.';
          return { message: msg };
        }
        const lines = list.map((s) => `  ${s.name.padEnd(24)} ${color.dim(`[${s.source}]`)} ${s.description.split('\n')[0]}`);
        const msg = `Skills:\n${lines.join('\n')}\n`;
        return { message: msg };
      } else {
        const skill = await opts.skillLoader.find(args.trim());
        if (!skill) {
          const msg = `Skill "${args.trim()}" not found.`;
          return { message: msg };
        }
        const body = await opts.skillLoader.readBody(skill.name);
        return { message: body };
      }
    },
  };
}

function useCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'use',
    description: 'Switch provider mid-session: /use <provider>',
    async run(args) {
      const name = args.trim();
      if (!name) {
        const msg = 'Usage: /use <provider-name>';
        return { message: msg };
      }
      opts.onSwitchProvider?.(name);
      const msg = `Switched provider to "${name}".`;
      return { message: msg };
    },
  };
}

function modelCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'model',
    description: 'Switch model mid-session: /model <model>',
    async run(args) {
      const name = args.trim();
      if (!name) {
        const msg = 'Usage: /model <model-name>';
        return { message: msg };
      }
      opts.onSwitchModel?.(name);
      const msg = `Switched model to "${name}".`;
      return { message: msg };
    },
  };
}

function saveCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'save',
    description: 'Save current session (auto by default; this forces flush).',
    async run(_args, ctx) {
      await ctx.session.append({
        type: 'session_end',
        ts: new Date().toISOString(),
        usage: opts.tokenCounter.total(),
      });
      const msg = `Session ${ctx.session.id} flushed.`;
      return { message: msg };
    },
  };
}

function loadCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'resume',
    aliases: ['load', 'sessions'],
    description:
      'List recent sessions. To actually resume, exit and run `wstack resume <id>`.',
    async run() {
      if (!opts.sessionStore) {
        const msg = 'No session store configured.';
        return { message: msg };
      }
      const list = await opts.sessionStore.list(10);
      if (list.length === 0) {
        const msg = 'No saved sessions.';
        return { message: msg };
      }
      const lines = list.map(
        (s) =>
          `  ${s.id}  ${color.dim(s.startedAt)}  ${color.dim(`${s.tokenTotal} tok`)}  ${s.title}`,
      );
      const msg =
        `Recent sessions:\n${lines.join('\n')}\n\n` +
        color.dim(`Resume one with: wstack resume ${list[0]?.id ?? '<id>'}\n`);
      opts.renderer.write(msg);
      return { message: msg };
    },
  };
}

function exitCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'exit',
    aliases: ['quit', 'q'],
    description: 'Exit the REPL.',
    async run() {
      opts.onExit?.();
      return { exit: true };
    },
  };
}
