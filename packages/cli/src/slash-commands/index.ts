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
   * available. Receives the task description and returns a one-line summary
   * once the subagent finishes (or an error). When unset, `/spawn` reports
   * that multi-agent is not enabled.
   */
  onSpawn?: (description: string) => Promise<string>;
  /** Lists active and completed subagents. Same on/off semantics as onSpawn. */
  onAgents?: () => string;
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
    metricsCommand(opts),
    healthCommand(opts),
    memoryCommand(opts),
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

function spawnCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'spawn',
    description:
      'Spawn an isolated subagent to handle a task. Usage: /spawn <task description>',
    async run(args) {
      const description = args.trim();
      if (!description) return { message: 'Usage: /spawn <task description>' };
      if (!opts.onSpawn) {
        return { message: 'Multi-agent is not enabled in this session.' };
      }
      try {
        const summary = await opts.onSpawn(description);
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
