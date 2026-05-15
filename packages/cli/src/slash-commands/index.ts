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
  MetricsSink,
  HealthRegistry,
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
  metricsSink?: MetricsSink;
  healthRegistry?: HealthRegistry;
  onExit?: () => void;
  onClear?: () => void;
  /**
   * Returns the diagnostics text. The TUI surfaces this as a history
   * entry (the renderer is silent there); REPL prints it via its
   * dispatcher. Avoid writing to the renderer directly from here — that
   * would either double-print in REPL or get swallowed by the TUI.
   */
  onDiag?: () => string;
  /** Same contract as `onDiag`. Returns `null` when there's no activity yet. */
  onStats?: () => string | null;
  /**
   * Optional spawn handler — wired by the CLI when the multi-agent host is
   * available. Receives the task description plus optional per-subagent
   * overrides (provider/model/tool slice/name) and returns a one-line
   * summary once the subagent finishes (or an error). When unset,
   * `/spawn` reports that multi-agent is not enabled.
   */
  onSpawn?: (
    description: string,
    opts?: { provider?: string; model?: string; tools?: string[]; name?: string },
  ) => Promise<string>;
  /** Lists active and completed subagents. Same on/off semantics as onSpawn. */
  onAgents?: () => string;
  /**
   * Fleet inspection / control surface. The CLI wires this when the
   * multi-agent host is available; the slash command dispatches by `action`:
   *   - 'status'   — same shape as /agents (kept here so /fleet works as a hub)
   *   - 'usage'    — per-subagent runtime cost (iterations / tools / ms)
   *   - 'kill'     — terminate a subagent; `target` is the subagent id
   *   - 'manifest' — print the in-memory manifest if a director is wired
   * Returns a formatted, ready-to-print string. Implementations should
   * never throw; surface errors as part of the returned string instead so
   * the slash dispatcher doesn't need a try/catch.
   */
  onFleet?: (action: 'status' | 'usage' | 'kill' | 'manifest', target?: string) => Promise<string>;
}

export function buildBuiltinSlashCommands(opts: SlashCommandContext): SlashCommand[] {
  return [
    helpCommand(opts),
    initCommand(opts),
    clearCommand(opts),
    compactCommand(opts),
    contextCommand(opts),
    toolsCommand(opts),
    skillCommand(opts),
    diagCommand(opts),
    statsCommand(opts),
    spawnCommand(opts),
    agentsCommand(opts),
    fleetCommand(opts),
    metricsCommand(opts),
    healthCommand(opts),
    memoryCommand(opts),
    todosCommand(opts),
    saveCommand(opts),
    loadCommand(opts),
    exitCommand(opts),
  ];
}

function memoryCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'memory',
    description:
      'Inspect or edit persistent memory: /memory [show|remember <text>|forget <query>|clear]',
    async run(args) {
      const store = opts.memoryStore;
      if (!store) return { message: 'No memory store configured.' };
      const [verb, ...rest] = args.trim().split(/\s+/);
      const restJoined = rest.join(' ').trim();
      switch (verb) {
        case '':
        case 'show':
        case 'list': {
          const text = await store.readAll();
          return {
            message: text.trim().length === 0
              ? 'Memory is empty. Add an entry with `/memory remember <text>`.'
              : text,
          };
        }
        case 'remember':
        case 'add': {
          if (!restJoined) return { message: 'Usage: /memory remember <text>' };
          await store.remember(restJoined);
          return { message: `Remembered: ${restJoined}` };
        }
        case 'forget':
        case 'rm': {
          if (!restJoined) return { message: 'Usage: /memory forget <query>' };
          const n = await store.forget(restJoined);
          return {
            message:
              n === 0 ? `No entries matched "${restJoined}".` : `Forgot ${n} entries.`,
          };
        }
        case 'clear': {
          await store.clear();
          return { message: 'Cleared all memory scopes.' };
        }
        default:
          return {
            message: `Unknown subcommand "${verb}". Try: show | remember <text> | forget <query> | clear`,
          };
      }
    },
  };
}

/**
 * Live todo inspector. The agent curates `context.todos` via the
 * TodoWrite tool; this command surfaces it so the user can see plan state
 * at any time and wipe it for a clean slate.
 *
 *   /todos                    list todos (default)
 *   /todos clear              drop them all
 *   /todos add <text>         append a pending todo manually
 *   /todos done <id|index>    mark a todo completed
 *
 * `add` / `done` are escape hatches — the agent's TodoWrite tool is still
 * the primary writer.
 */
function todosCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'todos',
    description:
      'Inspect or edit the live todo list: /todos [show|clear|add <text>|done <id|index>]',
    async run(args) {
      const ctx = opts.context;
      if (!ctx) return { message: 'No active context.' };
      const [verb, ...rest] = args.trim().split(/\s+/);
      const restJoined = rest.join(' ').trim();
      switch (verb) {
        case '':
        case 'show':
        case 'list': {
          const todos = ctx.todos;
          if (todos.length === 0) {
            return { message: 'No todos. The agent will add some when it plans work.' };
          }
          const lines: string[] = [];
          const done = todos.filter((t) => t.status === 'completed').length;
          lines.push(color.dim(`Todos (${done}/${todos.length} done):`));
          todos.forEach((t, i) => {
            const mark =
              t.status === 'completed'
                ? color.green('[x]')
                : t.status === 'in_progress'
                  ? color.yellow('[~]')
                  : color.dim('[ ]');
            const text =
              t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
            const label = t.status === 'completed' ? color.dim(text) : text;
            lines.push(`  ${color.dim(String(i + 1).padStart(2))}. ${mark} ${label}`);
          });
          return { message: lines.join('\n') };
        }
        case 'clear': {
          const n = ctx.todos.length;
          ctx.todos.length = 0;
          return { message: n === 0 ? 'Todos were already empty.' : `Cleared ${n} todo${n === 1 ? '' : 's'}.` };
        }
        case 'add': {
          if (!restJoined) return { message: 'Usage: /todos add <text>' };
          ctx.todos.push({
            id: `todo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            content: restJoined,
            status: 'pending',
          });
          return { message: `Added: ${restJoined}` };
        }
        case 'done':
        case 'complete': {
          if (!restJoined) return { message: 'Usage: /todos done <id|index>' };
          // Accept either the todo's id or a 1-based index for ergonomics.
          const asIndex = Number.parseInt(restJoined, 10);
          let target = !Number.isNaN(asIndex)
            ? ctx.todos[asIndex - 1]
            : ctx.todos.find((t) => t.id === restJoined);
          if (!target) {
            target = ctx.todos.find((t) => t.content.toLowerCase().includes(restJoined.toLowerCase()));
          }
          if (!target) return { message: `No todo matched "${restJoined}".` };
          target.status = 'completed';
          return { message: `Marked done: ${target.content}` };
        }
        default:
          return {
            message: `Unknown subcommand "${verb}". Try: show | clear | add <text> | done <id|index>`,
          };
      }
    },
  };
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
      }
      const msg = `Wrote ${file}\nNo project type auto-detected. Edit the file to add build/test commands and conventions.`;
      opts.renderer.writeInfo(`Wrote ${file}`);
      return { message: msg };
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
      if (!opts.onDiag) return { message: 'Diag not available in this context.' };
      return { message: opts.onDiag() };
    },
  };
}

function statsCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'stats',
    description: 'Show session report: tokens, requests, tools, files, cost.',
    async run() {
      if (!opts.onStats) return { message: 'Stats not available in this context.' };
      const text = opts.onStats();
      return { message: text ?? 'No session activity recorded yet.' };
    },
  };
}

function helpCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'help',
    description: 'Show available slash commands. Pass a name for detailed help.',
    help: [
      'Usage:',
      '  /help            List every command with its one-line description.',
      '  /help <name>     Show detailed help for one command (falls back to the description).',
      '',
      'Examples:',
      '  /help',
      '  /help context',
      '  /help model',
    ].join('\n'),
    async run(args) {
      const query = args.trim();
      if (query) {
        // Strip a leading slash if the user wrote `/help /foo`.
        const needle = query.startsWith('/') ? query.slice(1) : query;
        let match:
          | { cmd: SlashCommand; owner: string; fullName: string }
          | undefined;
        for (const entry of opts.registry.listWithOwner()) {
          const aliases = entry.cmd.aliases ?? [];
          const candidates = [
            entry.cmd.name,
            entry.fullName,
            ...aliases,
            ...aliases.map(
              (a) => (entry.owner === 'core' ? a : `${entry.owner}:${a}`),
            ),
          ];
          if (candidates.includes(needle)) {
            match = entry;
            break;
          }
        }
        if (!match) {
          return { message: `Unknown command: /${needle}. Run /help to list commands.` };
        }
        const prefix = match.owner === 'core' ? '' : `${match.owner}:`;
        const header = `/${prefix}${match.cmd.name}`;
        const aliasLine =
          match.cmd.aliases && match.cmd.aliases.length > 0
            ? `Aliases: ${match.cmd.aliases.map((a) => `/${prefix}${a}`).join(', ')}\n`
            : '';
        const body = match.cmd.help ?? match.cmd.description;
        return {
          message: [
            header,
            '─'.repeat(header.length),
            aliasLine + (match.cmd.help ? '' : `${match.cmd.description}\n`),
            body,
          ]
            .filter(Boolean)
            .join('\n'),
        };
      }
      const lines = ['Available slash commands:'];
      for (const { cmd, owner } of opts.registry.listWithOwner()) {
        const isBuiltin = owner === 'core';
        const prefix = isBuiltin ? '' : `${owner}:`;
        const aliases = cmd.aliases
          ? cmd.aliases.map((a) => `/${prefix}${a}`).join(', ')
          : '';
        const aliasStr = aliases ? ` (${aliases})` : '';
        lines.push(`  /${prefix}${cmd.name}${aliasStr} — ${cmd.description}`);
      }
      lines.push('', 'Run `/help <name>` for detailed help on a specific command.');
      return { message: lines.join('\n') };
    },
  };
}

function clearCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'clear',
    description: 'Reset the session and start a new one.',
    help: [
      'Usage:',
      '  /clear',
      '',
      'Wipes everything in the current REPL state: messages, todos, read-file tracking,',
      'file mtimes, meta. Memory store entries (all scopes) are cleared too. The terminal',
      'is wiped. Use this when you want a fresh conversation without restarting `wstack`.',
    ].join('\n'),
    async run(_args, ctx) {
      // Clear context: messages, todos, readFiles, fileMtimes
      if (ctx) {
        ctx.state.replaceMessages([]);
        ctx.state.replaceTodos([]);
        ctx.readFiles.clear();
        ctx.fileMtimes.clear();
        for (const key of Object.keys(ctx.meta)) ctx.state.deleteMeta(key);
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
    help: [
      'Usage:',
      '  /context           Show counts: messages, est. tokens, tool calls, todos, read files.',
      '  /context detail    As above, plus model, cwd, projectRoot, and the file list.',
      '',
      'Token estimate is a `chars ÷ 4` heuristic, not a real tokenizer call —',
      'good enough to spot growth between turns.',
    ].join('\n'),
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
    help: [
      'Usage:',
      '  /compact              Run the configured compactor with default settings.',
      '  /compact aggressive   Compact more aggressively — keeps fewer recent turns verbatim.',
      '',
      'The compactor summarizes older turns to reclaim tokens. The default keeps the most',
      'recent K message pairs untouched; aggressive halves that window.',
    ].join('\n'),
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
    description: 'Show skill details or list available skills.',
    async run(args) {
      if (!opts.skillLoader) {
        const msg = 'No skill loader configured.';
        return { message: msg };
      }
      if (!args.trim()) {
        const entries = await opts.skillLoader.listEntries();
        if (entries.length === 0) {
          const msg = 'No skills found.';
          return { message: msg };
        }
        const lines = entries.map((e) => {
          const scopeTag = e.scope.length > 0 ? `  ${color.dim(`(${e.scope.slice(0, 3).join(', ')})`)}` : '';
          return `  ${color.bold(e.name)}${scopeTag}\n    Use when: ${e.trigger}`;
        });
        const msg = `Available skills:\n${lines.join('\n\n')}\n`;
        return { message: msg };
      }
      const skill = await opts.skillLoader.find(args.trim());
      if (!skill) {
        const msg = `Skill "${args.trim()}" not found.`;
        return { message: msg };
      }
      const body = await opts.skillLoader.readBody(skill.name);
      return { message: body };
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

function metricsCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'metrics',
    description: 'Show metrics snapshot (requires --metrics flag).',
    async run() {
      if (!opts.metricsSink) {
        return { message: 'Metrics not enabled. Restart with --metrics to collect.' };
      }
      const snap = opts.metricsSink.snapshot();
      if (snap.series.length === 0) {
        return { message: 'No metrics recorded yet.' };
      }
      const lines: string[] = [];
      // Group by metric name for a more readable dump
      const byName = new Map<string, typeof snap.series>();
      for (const s of snap.series) {
        const bucket = byName.get(s.name) ?? [];
        bucket.push(s);
        byName.set(s.name, bucket);
      }
      for (const [name, series] of [...byName.entries()].sort()) {
        lines.push(color.dim(`# ${name}`));
        for (const s of series) {
          const labels = Object.entries(s.labels).map(([k, v]) => `${k}=${v}`).join(' ');
          const labelStr = labels ? color.dim(` {${labels}}`) : '';
          if (s.type === 'histogram') {
            lines.push(
              `  count=${s.values.count} sum=${s.values.sum} min=${s.values.min} max=${s.values.max} p50=${s.values.p50} p95=${s.values.p95} p99=${s.values.p99}${labelStr}`,
            );
          } else {
            lines.push(`  ${s.values.value}${labelStr}`);
          }
        }
      }
      const msg = lines.join('\n');
      return { message: msg };
    },
  };
}

function healthCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'health',
    description: 'Run health checks (requires --metrics flag).',
    async run() {
      if (!opts.healthRegistry) {
        return { message: 'Health checks not enabled. Restart with --metrics.' };
      }
      const result = await opts.healthRegistry.run();
      const lines: string[] = [
        `${statusIcon(result.status)} overall: ${result.status}`,
        ...result.checks.map((c) => {
          const detail = c.detail ? color.dim(` — ${c.detail}`) : '';
          return `  ${statusIcon(c.status)} ${c.name}: ${c.status}${detail}`;
        }),
      ];
      return { message: lines.join('\n') };
    },
  };
}

function statusIcon(status: string): string {
  if (status === 'healthy') return color.green('●');
  if (status === 'degraded') return color.yellow('●');
  return color.red('●');
}

/**
 * Parse `/spawn` flags from the args head. Supported:
 *   --provider=<id> / -p <id>   override the subagent's provider id
 *   --model=<id>    / -m <id>   override the subagent's model
 *   --name=<label>  / -n <label> display name
 *   --tools=a,b,c               restrict the subagent's tool slice
 *
 * Anything after the last flag is the task description. Returns null
 * when no flags are present (legacy `/spawn <description>` path) so the
 * caller can take the cheap path. Whitespace inside quoted descriptions
 * is preserved.
 */
function parseSpawnFlags(input: string): {
  description: string;
  opts: { provider?: string; model?: string; tools?: string[]; name?: string };
} {
  const opts: { provider?: string; model?: string; tools?: string[]; name?: string } = {};
  // Tokenize from the start, peeling off recognized flags one at a time.
  // We stop as soon as we hit a non-flag token; the remainder of the
  // string (preserving inner whitespace and quotes) becomes the description.
  let rest = input;
  const consume = (re: RegExp): RegExpMatchArray | null => {
    const m = rest.match(re);
    if (m) {
      rest = rest.slice(m[0].length).replace(/^\s+/, '');
      return m;
    }
    return null;
  };
  while (rest.length > 0) {
    let m: RegExpMatchArray | null;
    if ((m = consume(/^--provider=(\S+)\s*/))) opts.provider = m[1];
    else if ((m = consume(/^--model=(\S+)\s*/))) opts.model = m[1];
    else if ((m = consume(/^--name=("([^"]+)"|(\S+))\s*/))) opts.name = m[2] ?? m[3];
    else if ((m = consume(/^--tools=(\S+)\s*/))) opts.tools = m[1]!.split(',').map((t) => t.trim()).filter(Boolean);
    else if ((m = consume(/^-p\s+(\S+)\s*/))) opts.provider = m[1];
    else if ((m = consume(/^-m\s+(\S+)\s*/))) opts.model = m[1];
    else if ((m = consume(/^-n\s+("([^"]+)"|(\S+))\s*/))) opts.name = m[2] ?? m[3];
    else break;
  }
  return { description: rest.trim(), opts };
}

function spawnCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'spawn',
    description:
      'Spawn an isolated subagent to handle a task. Usage: /spawn [--provider=<id>] [--model=<id>] [--name=<label>] [--tools=a,b,c] <task description>',
    async run(args) {
      const { description, opts: parsed } = parseSpawnFlags(args.trim());
      if (!description) {
        return {
          message:
            'Usage: /spawn [--provider=<id>] [--model=<id>] [--name=<label>] [--tools=a,b,c] <task description>',
        };
      }
      if (!opts.onSpawn) {
        return { message: 'Multi-agent is not enabled in this session.' };
      }
      try {
        // Preserve legacy call signature when no flags were given so
        // existing test assertions of the form `toHaveBeenCalledWith(description)`
        // — and any external onSpawn implementations that overload by arity
        // — keep working. Only pass the second arg when there's something
        // worth saying about it.
        const summary = Object.keys(parsed).length > 0
          ? await opts.onSpawn(description, parsed)
          : await opts.onSpawn(description);
        return { message: summary };
      } catch (err) {
        return {
          message: `Spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

function agentsCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'agents',
    description: 'Show status of spawned subagents (pending + completed tasks).',
    async run() {
      if (!opts.onAgents) {
        return { message: 'Multi-agent is not enabled in this session.' };
      }
      return { message: opts.onAgents() };
    },
  };
}

/**
 * Fleet inspection / control hub. Dispatches to `onFleet` with a typed
 * action; the heavy lifting lives in the CLI's `MultiAgentHost` wrapper.
 * Kept thin on purpose — the slash command just parses + routes, the
 * host owns the data and formatting.
 *
 *   /fleet                  → status (default)
 *   /fleet status           → status table (same as /agents but kept here for hub feel)
 *   /fleet usage            → per-subagent iterations/tools/ms roll-up
 *   /fleet kill <id>        → terminate a subagent by id (prefix-matched by the host)
 *   /fleet manifest         → in-memory manifest dump (no-op without a director)
 *   /fleet help             → usage block
 *
 * The `kill` subcommand is the one mutating action; everything else is
 * read-only and safe to call repeatedly while the fleet is running.
 */
function fleetCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'fleet',
    description:
      'Inspect or control the subagent fleet: /fleet [status|usage|kill <id>|manifest|help]',
    help: [
      'Usage:',
      '  /fleet                  Show fleet status (alias for /fleet status).',
      '  /fleet status           Pending + completed subagent task table.',
      '  /fleet usage            Per-subagent runtime cost — iterations, tool calls, duration.',
      '  /fleet kill <id>        Terminate a running subagent by id (or prefix).',
      '  /fleet manifest         Print the director manifest (only with --director).',
      '  /fleet help             Show this help.',
      '',
      'Subagent ids are returned by /spawn and listed in /fleet status.',
    ].join('\n'),
    async run(args) {
      if (!opts.onFleet) {
        return { message: 'Multi-agent is not enabled in this session.' };
      }
      const trimmed = args.trim();
      const [verb, ...rest] = trimmed.length === 0 ? ['status'] : trimmed.split(/\s+/);
      const target = rest.join(' ').trim() || undefined;
      switch (verb) {
        case 'status':
        case 'usage':
        case 'manifest': {
          const out = await opts.onFleet(verb, undefined);
          return { message: out };
        }
        case 'kill': {
          if (!target) {
            return { message: 'Usage: /fleet kill <subagent-id>' };
          }
          const out = await opts.onFleet('kill', target);
          return { message: out };
        }
        case 'help':
        case '?':
          return {
            message: [
              '/fleet — inspect or control the subagent fleet',
              '',
              '  /fleet                  → status (default)',
              '  /fleet status           pending + completed tasks per subagent',
              '  /fleet usage            iterations, tool calls, duration roll-up',
              '  /fleet kill <id>        terminate a subagent',
              '  /fleet manifest         director manifest (requires --director)',
            ].join('\n'),
          };
        default:
          return {
            message: `Unknown subcommand "${verb}". Try: status | usage | kill <id> | manifest | help`,
          };
      }
    },
  };
}
