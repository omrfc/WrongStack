# Slash Commands - Overview

WrongStack's REPL supports core slash commands plus commands registered by built-in plugins. Commands are registered into `SlashCommandRegistry`, dispatched by name, and wired with a shared `SlashCommandContext`.

## Core command map

| Command | Source | What it does |
|---|---|---|
| `/help` | `packages/cli/src/slash-commands/help.ts` | List all commands; show detailed help for a named command |
| `/init` | `packages/cli/src/slash-commands/init.ts` | Create or update `.wrongstack/AGENTS.md` |
| `/clear` | `packages/cli/src/slash-commands/clear.ts` | Wipe session state and terminal view |
| `/compact` | `packages/cli/src/slash-commands/compact.ts` | Run the context-window compactor |
| `/context` | `packages/cli/src/slash-commands/context.ts` | Context summary, repair, mode, and limit controls; `/ctx` alias |
| `/codebase-reindex` | `packages/cli/src/slash-commands/codebase-reindex.ts` | Rebuild the codebase symbol index; `/reindex` alias |
| `/diag` | `packages/cli/src/slash-commands/diag-stats.ts` | Runtime diagnostics |
| `/stats` | `packages/cli/src/slash-commands/diag-stats.ts` | Session report |
| `/memory` | `packages/cli/src/slash-commands/memory.ts` | Persistent memory: show, remember, forget, clear |
| `/todos` | `packages/cli/src/slash-commands/todos.ts` | Session todo list |
| `/tasks` | `packages/cli/src/slash-commands/tasks.ts` | Structured task management with dependencies and priorities |
| `/mode` | `packages/cli/src/slash-commands/mode.ts` | Switch or view session mode |
| `/setmodel` | `packages/cli/src/slash-commands/setmodel.ts` | View or set leader model and per-task model matrix |
| `/models` | `packages/cli/src/slash-commands/models.ts` | Manage custom model definitions |
| `/modelcaps` | `packages/cli/src/slash-commands/modelcaps.ts` | Browse model capacities and pricing across providers |
| `/yolo` | `packages/cli/src/slash-commands/yolo.ts` | Toggle or query YOLO mode |
| `/autonomy` | `packages/cli/src/slash-commands/autonomy.ts` | Set autonomy level |
| `/goal` | `packages/cli/src/slash-commands/goal.ts` | Set, show, pause, resume, journal, or clear an autonomous mission |
| `/save` | `packages/cli/src/slash-commands/session.ts` | Force-flush session to disk |
| `/sessions` | `packages/cli/src/slash-commands/session.ts` | List recent sessions; `/resume`, `/load` aliases for backward compat |
| `/prune` | `packages/cli/src/slash-commands/prune.ts` | Delete old sessions; `/prune --dry-run` to preview |
| `/exit` | `packages/cli/src/slash-commands/session.ts` | Exit REPL; `/quit`, `/q` aliases |
| `/tools` | `packages/cli/src/slash-commands/tools.ts` | List registered tools |
| `/plugin` | `packages/cli/src/slash-commands/plugin.ts` | Manage plugins |
| `/mcp` | `packages/cli/src/slash-commands/mcp.ts` | Manage MCP servers |
| `/auth` | `packages/cli/src/slash-commands/auth.ts` | API key status dashboard; run `wstack auth` for full key manager |
| `/spawn` | `packages/cli/src/slash-commands/spawn-agents.ts` | Spawn an isolated subagent |
| `/agents` | `packages/cli/src/slash-commands/spawn-agents.ts` | Show subagents or toggle the agents monitor |
| `/director` | `packages/cli/src/slash-commands/spawn-agents.ts` | Promote to director mode |
| `/delegate` | `packages/cli/src/slash-commands/delegate.ts` | Hand a task to a specialist subagent; `/delegate list` for roles |
| `/fleet` | `packages/cli/src/slash-commands/fleet.ts` | Fleet status, usage, kill, manifest, retry, log, stream |
| `/sdd` | `packages/cli/src/slash-commands/sdd.ts` | Spec-driven development workflow |
| `/btw` | `packages/cli/src/slash-commands/btw.ts` | Quick side-note workflow |
| `/next` | `packages/cli/src/slash-commands/next.ts` | Toggle next-task prediction |
| `/suggest` | `packages/cli/src/slash-commands/suggest.ts` | Generate context-aware next-step suggestions; `/suggest --fast` for heuristics |
| `/enhance` | `packages/cli/src/slash-commands/enhance.ts` | Toggle prompt refinement ("did you mean this?") before sending |
| `/fix` | `packages/cli/src/slash-commands/fix.ts` | Classify and route a bug/error fix |
| `/autophase` | `packages/cli/src/slash-commands/autophase.ts` | Autonomous phase-based workflow |
| `/worktree` | `packages/cli/src/slash-commands/worktree.ts` | Inspect and manage worktrees used by AutoPhase |
| `/settings` | `packages/cli/src/slash-commands/settings.ts` | View or change runtime settings |
| `/telegram-setup` | `packages/cli/src/slash-commands/telegram-setup.ts` | Configure Telegram bot token and default chat; `/tg-setup` alias |
| `/collab` | `packages/cli/src/slash-commands/collab.ts` | Live collaboration helpers |
| `/statusline` | `packages/cli/src/slash-commands/statusline.ts` | Toggle TUI status bar items; `/sl` alias |

## Built-in plugin commands

These commands are enabled by default when plugins are enabled and their host dependencies are available.

| Command | Source | What it does |
|---|---|---|
| `/prompts` | `packages/core/src/plugins/prompts-plugin.ts` | Manage the personal prompt library |
| `/sync` | `packages/core/src/plugins/sync-plugin.ts` | GitHub-backed sync for prompts, skills, settings, memory, and history |
| `/commit` | `packages/core/src/plugins/git-plugin.ts` | Stage all changes and commit with an auto-generated message; `/gc` alias |
| `/gitcheck` | `packages/core/src/plugins/git-plugin.ts` | Silent uncommitted-change check; `/gcstatus` alias |
| `/push` | `packages/core/src/plugins/git-plugin.ts` | Push current branch to configured remotes |
| `/metrics` | `packages/core/src/plugins/observability-plugin.ts` | Metrics snapshot; requires `--metrics` |
| `/health` | `packages/core/src/plugins/observability-plugin.ts` | Run health checks; requires `--metrics` |
| `/security` | `packages/core/src/plugins/security-plugin.ts` | Security scan, audit, and report commands |
| `/skill` | `packages/core/src/plugins/skills-plugin.ts` | List skills or show a skill body |
| `/skill-gen` | `packages/core/src/plugins/skills-plugin.ts` | LLM-guided skill authoring |
| `/skill-install` | `packages/core/src/plugins/skills-plugin.ts` | Install skills from GitHub |
| `/skill-update` | `packages/core/src/plugins/skills-plugin.ts` | Update installed skills |
| `/skill-uninstall` | `packages/core/src/plugins/skills-plugin.ts` | Remove installed skills |
| `/plan` | `packages/core/src/plugins/plan-plugin.ts` | Strategic plan board |

Optional built-in plugins, such as the LSP and Telegram plugins, can also register slash commands when enabled.

## Dispatch flow

```text
REPL input "/<command> <args>"
  -> SlashCommandRegistry.dispatch(name, args, ctx)
  -> matching SlashCommand.run(args, ctx)
  -> returns { message?: string, runText?: string, exit?: boolean }
```

`runText` is a special field: when a slash command returns it, the REPL injects that text into the next agent turn. `/goal`, `/sdd`, `/autonomy`, `/fix`, and `/skill-gen` use this to steer the AI conversation without the user typing the full prompt.

## Adding a core slash command

1. Create `packages/cli/src/slash-commands/<name>.ts`.
2. Export `buildXxxCommand(opts: SlashCommandContext): SlashCommand`.
3. Import and add it to `buildBuiltinSlashCommands()` in `packages/cli/src/slash-commands/index.ts`.
4. Add tests under `packages/cli/tests/`.
5. Add or update docs under `docs/slash/`.

### Recommended patterns

**Arg parsing:** Use `parseSubcommand(args)` from `helpers.ts` instead of raw
`args.trim().split(/\s+/)`. Returns `{ cmd, rest }` where `cmd` is the lowercase
first token and `rest` is the remaining tokens.

```typescript
import { parseSubcommand, unknownSubcommand } from './helpers.js';

async run(args) {
  const { cmd, rest } = parseSubcommand(args);
  switch (cmd) {
    case 'sub1': return handleSub1(rest);
    case 'sub2': return handleSub2(rest);
    default:
      return { message: unknownSubcommand(cmd, ['sub1', 'sub2'], 'mycommand') };
  }
}
```

## Adding a plugin slash command

Register it from a plugin with `api.slashCommands.register(command)` and declare `capabilities: { slashCommands: true }`. First-party built-in plugins can claim bare command names; user plugins are namespaced by owner unless the host marks them official.
