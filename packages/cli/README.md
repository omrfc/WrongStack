# @wrongstack/cli

The terminal binary for WrongStack. Provides the `wstack` and `wrongstack` commands.

Most users don't depend on this package directly — they install [`wrongstack`](../../README.md) (the umbrella) and run `wrongstack` / `wstack` from any project directory.

## Install

```bash
npm install -g wrongstack
```

The `wrongstack` umbrella package transitively installs `@wrongstack/cli` along with `core`, `providers`, `tools`, `mcp`, and `tui`.

## Commands

```bash
wstack                        # interactive REPL — no flags = default
wstack --tui                  # Ink-based TUI
wstack --yolo                 # auto-approve every tool call
wstack "refactor src/auth.ts" # one-shot query (no interactive loop)

wstack --provider <id> --model <id>   # skip the picker
wstack --resume <session-id>          # resume a saved session
wstack resume <session-id>            # equivalent

wstack init                   # interactive provider+model wizard
wstack doctor                 # config/key/MCP/Node health check
wstack export <session-id>    # render a session as markdown/JSON/plain text
wstack mcp add <preset>       # add an MCP server (see @wrongstack/mcp)
wstack mcp list               # show configured MCP servers
```

`--no-tui` forces REPL mode even when `--tui` is configured globally. The TUI uses Ink's alt-screen buffer by default so it can capture every keystroke (Ctrl+S/Q/Z/\\ included) and avoid live-region leaks into scrollback; pass `--no-alt-screen` if you specifically want completed chat to survive after exit.

## Slash commands inside the REPL/TUI

```
/help                # list of commands
/help <name>         # detailed help for one command
/clear               # wipe context + memory + visible history
/model               # change model mid-session
/use <provider>      # switch provider
/mode <id>           # activate a mode (debugger, code-reviewer, …)
/memory              # show/edit project memory
/skill [name]        # list skills / show a specific skill
/context             # show token usage breakdown
/sessions            # list past sessions
/resume <id>         # resume a session
/todos [show|add|done|clear]    # tactical task board (auto-checkpointed)
/plan  [show|add|start|done|remove|clear]   # strategic roadmap (persistent across resume)
/director            # promote the current session into multi-agent director mode
/fleet status|usage|kill|manifest|retry [taskId|all]|log [<id> [raw]]  # inspect/control + retry + view subagent transcripts
/exit                # quit
```

## Configuration

```
~/.wrongstack/config.json            global config (provider, model defaults, features)
~/.wrongstack/.key                   AES-256-GCM secret-vault key (mode 0600)
~/.wrongstack/memory.md              user-global memory
~/.wrongstack/skills/                user-global skills
~/.wrongstack/projects/<hash>/       per-project state
  memory.md                          project memory (auto-gitignored)
  sessions/                          per-session artifacts
    <id>.jsonl                       append-only event log (messages, tool calls, task_* events)
    <id>.summary.json                fast-path manifest read by /sessions
    <id>.todos.json                  ctx.todos checkpoint (atomic-written on every mutation)
    <id>.plan.json                   /plan strategic roadmap (atomic-written on every mutation)
    <id>/                            multi-agent (director mode) fleet workspace
      fleet.json                     director manifest (debounced ~2s; final on shutdown)
      director-state.json            live task graph: pending/running/completed + spawn roster
      shared/                        cross-subagent scratchpad (markdown findings)
      subagents/<runId>/<subagentId>.jsonl   per-subagent transcripts
      attachments/                   spooled images/files for the session
  trust.json                         per-project tool/permission trust
.wrongstack/AGENTS.md                committable project memory
.wrongstack/skills/                  committable project skills
```

**Resume semantics.** `wstack --resume <id>` replays the messages JSONL into the agent context, reloads `<id>.todos.json` if present, and surfaces a banner summarizing any prior plan items and unfinished fleet tasks. Per-subagent transcripts under `subagents/` survive crashes — combine with the `director-state.json` checkpoint to inspect what each worker was doing when the run was interrupted.

API keys are encrypted at rest with AES-256-GCM and the key file at `~/.wrongstack/.key`. The vault auto-bootstraps on first run; the key never leaves the machine.

## Flags

| Flag | Effect |
|------|--------|
| `--tui` / `--no-tui` | Force/disable Ink TUI |
| `--yolo` | Auto-approve every tool call (use with care) |
| `--provider <id>` | Override the configured provider |
| `--model <id>` | Override the configured model |
| `--resume <id>` | Resume a saved session by id |
| `--no-alt-screen` | Render TUI inline in scrollback (default is alt-screen so all shortcuts are captured). |
| `--config <path>` | Use a non-default config file |
| `--debug` | Verbose logging to `~/.wrongstack/logs/wrongstack.log` |
| `--version` | Print version |
| `--help` | Print help |

## Environment variables

| Variable | Purpose |
|----------|---------|
| `WRONGSTACK_BASH_ENV_PASSTHROUGH=1` | Disable the bash-tool env allowlist (legacy unsafe mode — see [SECURITY.md](../../SECURITY.md)) |
| `WRONGSTACK_CONFIG_DIR` | Override `~/.wrongstack` location |
| `WRONGSTACK_DEBUG=1` | Same as `--debug` |
| `NO_COLOR=1` | Disable ANSI colors |

Provider API keys can be set via env (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) or stored encrypted via `wstack` first-run wizard.

## License

MIT
