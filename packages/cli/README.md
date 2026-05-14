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

`--no-tui` forces REPL mode even when `--tui` is configured globally. `--alt-screen` opts into Ink's alt-screen rendering (off by default so the user keeps native scrollback).

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
  sessions/                          JSONL session logs
  trust.json                         per-project tool/permission trust
.wrongstack/AGENTS.md                committable project memory
.wrongstack/skills/                  committable project skills
```

API keys are encrypted at rest with AES-256-GCM and the key file at `~/.wrongstack/.key`. The vault auto-bootstraps on first run; the key never leaves the machine.

## Flags

| Flag | Effect |
|------|--------|
| `--tui` / `--no-tui` | Force/disable Ink TUI |
| `--yolo` | Auto-approve every tool call (use with care) |
| `--provider <id>` | Override the configured provider |
| `--model <id>` | Override the configured model |
| `--resume <id>` | Resume a saved session by id |
| `--alt-screen` | Opt into alt-screen TUI rendering |
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
