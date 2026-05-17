# WrongStack

> Built on the wrong stack. Shipped anyway.

A CLI AI coding agent that runs in your terminal. It reads your code, edits files, runs commands, and reasons through bugs — while you stay in control of every permission.

Provider catalog comes from [models.dev](https://models.dev) — no hardcoded provider lists, no hardcoded pricing, no hardcoded model names. API keys are encrypted at rest with a per-machine key. Every developer-level config lives under `~/.wrongstack/`; the only thing you'd ever commit to a repo is `.wrongstack/AGENTS.md`.

## Requirements

- **Node.js** ≥ 22.0.0
- **pnpm** ≥ 9.0.0 (recommended) or npm

## Install

```bash
npm install -g wrongstack
```

This pulls in the full stack — `@wrongstack/core`, `@wrongstack/runtime`, `@wrongstack/providers`, `@wrongstack/tools`, `@wrongstack/mcp`, `@wrongstack/plug-lsp`, and `@wrongstack/tui`. The TUI is shipped but lazy-loaded behind `--tui`, so plain-REPL users pay no React/Ink import cost at startup. The web-based UI (`@wrongstack/webui`) is available as a separate binary (`webui`).

After install, `wrongstack` is on your `PATH`. (`wstack` works too — it's an alias.)

### What's new in 0.3.2

This patch release tightens the package architecture, improves context-window
control, adds image routing, and quiets the multi-agent TUI.

**Context-window modes and repair.** Sessions can switch between `balanced`,
`frugal`, `deep`, and `archival` context policies. CLI users get `/context mode`
and `/context repair`; WebUI clients get mode switching plus `context.repair`.
Damaged tool-call adjacency is repaired before provider requests.

**Core stays core.** `@wrongstack/runtime` is the new home for concrete runtime
defaults and host composition helpers. `@wrongstack/core` keeps the kernel,
agent contracts, registries, plugin API, and lifecycle primitives.

**Extension packs.** `@wrongstack/tools/pack` exports `builtinToolsPack`, and
CLI/WebUI now register built-ins through that pack shape. This is the migration
path for CLI, TUI, WebUI, Telegram, tools, providers, and future integrations
to behave like extension packages around the core.

**Quieter multi-agent UI.** Subagent tool calls no longer spam chat as separate
`[AGENT#N]` entries. The TUI keeps the last two tool calls and last two text
snippets per agent in `LiveActivityStrip` / `FleetPanel`; the main chat keeps
agent text and lifecycle summaries.

**`grep` correctness.** The `rg` backend now validates regex syntax up front,
honors default ignored directories consistently, and reports real total match
counts in `output_mode: "count"`.

**Image routing.** TUI `Alt+V` and CLI `/image` attach clipboard PNGs as real
image blocks. Vision-capable models receive them natively; text-only models can
fall back to safe read-only MCP/tool adapters that describe the image. If no
route exists, WrongStack tells you to switch to a vision model or enable an
image-understanding adapter instead of silently dropping the image.

**Release gate cleanup.** `pnpm test` is green again at 2059 passing tests
across 203 files, with 1 skipped. Todo checkpoint writes now drain during
detach/shutdown, CLI compaction resolves model capabilities through the active
provider id, director tools live in a single module, and WebUI builds without
the previous chime import/chunk-size warnings.

### What's new in 0.2.0 — the autonomous fleet release

Six weeks. One question: can a Director run for hours without the user
babysitting it? Answering it took a full pass over the coordination
layer — every race fixed, every silent failure classified, every "what
is the subagent doing right now?" question answered with a visible chip.
No breaking changes; CLI flags, plugin API, and EventBus contract are
backwards compatible.

**`/goal <description>` — locked-in autonomous mode.** Hands the agent
a task it MUST drive to a verifiable finish. The slash command prepends
a four-section preamble to the next turn — AUTHORITY (unlimited fan-out,
any provider/model, retry-until-it-works), DONE (concrete artifact +
10-second verification recipe + no hedges), NOT DONE (explicit
anti-patterns: unhandled errors, "should I continue?" hedges, partial
progress dressed up as success), and PERSISTENCE (three-angle rule
for blockers). Only the user can stop it — Esc / `/steer` redirect,
Ctrl+C / `/fleet kill` bail out.

**`--goal` and `--ask` boot flags.** Launch goal mode directly from the
shell — no need to type `/goal` after startup. `--goal` auto-enables
`--tui` since goal mode depends on the steering surface. One-line fleet
kickoff: `wstack --director --goal "audit packages/core for races"`.

**`/steer <text>` and **`Esc`** — mid-flight redirect.** Aborts the
active iteration, terminates running subagents (1.5s cap), drops
queued messages, then sends the new direction with a STEERING preamble
that tells the model exactly what was in flight (which tools, which
subagents, last partial output) and grants explicit authority to
abandon the prior plan. The chat just shows `↯ <text>` — the rich
context goes to the model, not the human view.

**Unlimited budgets by default.** The prior 20-tool / 20-iteration
hardcap on `/spawn` adhoc subagents and the 1000-tool / 200-iter /
4-hour `defaultBudget` are gone — the orchestrator (`delegate` /
`spawn_subagent`) is the budget owner now, and the Agent's iteration
loop auto-extends every 100 iters forever (`autoExtendLimit: true`).
`maxConcurrent` raised 2→8, `maxSpawnDepth` 2→5 so recursive
delegation actually works. Subagents only die from real causes:
parent abort, per-tool 300s timeout, orchestrator-set explicit
budget, or a classified provider error.

**Live activity strip + compact fleet panel.** Compact one-line-
per-subagent strip sits directly above the input area showing
`● bug-hunter · → bash (12.3s) · 5it 12tc · 1m23s`. The TUI keeps the
last two tool calls and text snippets per worker in the live surfaces,
so tool telemetry stays visible without filling chat history.

**SubagentError envelope (14 kinds).** `provider_5xx`,
`provider_rate_limit`, `provider_auth`, `context_overflow`,
`tool_failed`, `tool_threw`, `budget_iterations`, `budget_tool_calls`,
`budget_tokens`, `budget_cost`, `budget_timeout`, `aborted_by_parent`,
`empty_response`, `bridge_failed`, `unknown` — each carries
`retryable`, optional `backoffMs`, and the original `cause`. The
delegate tool exposes `errorKind` / `retryable` / `backoffMs` so the
LLM can branch on classification instead of substring-matching error
messages. Chat shows `[kind]` chip beside every failed task.

**Coordinator race fixes** — `spawn()` rejects duplicate ids,
`stop()`+`assign()` race produces synthetic `aborted_by_parent` instead
of orphan tasks, `stopAll()` drains the pending queue, error-state
reset is synchronous (no more `queueMicrotask` race), tool counter
pairs on `tool.executed` (not `tool.started`), per-task `dispose` hook
closes per-subagent JSONL writers deterministically.

**`tool.progress` heartbeat budget check.** Long-running tools that
emit progress (`bash` chunks, `fetch` byte progress, `spawn-stream`
stdout) now bust wall-clock budgets mid-tool. A `bash sleep 3600` no
longer parks past its deadline waiting for the coordinator's hard
Promise.race — the budget trips on the next heartbeat and aborts
cooperatively.

**Observability surface.** `currentTool` (set on `tool.started`,
cleared on `tool.executed`) — FleetPanel renders `→ bash (250ms)`
under each running subagent. `transcriptPath` on `subagent.spawned`
events — the per-subagent JSONL path is visible in FleetPanel, no
more `find ~/.wrongstack/sessions -name '*.jsonl'`. `provider.thinking
_delta` forwarded onto the FleetBus. Director shutdown errors funnel
through `process.emitWarning('DirectorShutdownWarning')` instead of
`.catch(() => undefined)` silent swallows.

**`/fleet log <id>`** — actual summary or raw transcript dump for any
on-disk subagent JSONL. Lists available transcripts when called
without an id, prints a compact event mix + first user message + last
LLM response by default, appends `raw` to dump the full JSONL.

**Session checkpoint system** — three new sidecar files turn `wstack
resume <id>` into "kaldığım yerden devam" instead of just message
replay: `<id>.todos.json` (ctx.todos mirror, 150ms debounced atomic
write), `<id>.plan.json` (strategic roadmap maintained via the new
`/plan` slash command), and `<id>/director-state.json` (live director
task graph, written incrementally on every spawn/assign/complete).
**`/fleet retry [taskId|all]`** finds tasks left mid-flight when the
previous process died, respawns the matching subagent, and re-assigns
— for crash recovery without re-running the whole session.

**`/plan` slash command + `planTool`** — strategic roadmap parallel to
todos. Six actions (`show|add|start|done|remove|clear`), items have
`open` / `in_progress` / `done` status. The plan is mirrored to disk
and surfaces a `📋 ⌛N ☐N ✓N` chip in the TUI status bar plus an
"Active plan" block in the system prompt every turn — anchoring the
LLM to the strategic intent across long autonomous runs.

**`delegate` tool — autonomous multi-agent activation.** A new
always-on built-in that bundles spawn + assign + await into one call.
Registered in every CLI session regardless of `--director` mode: the
first call auto-promotes to director mode under the hood, so the LLM
no longer needs the user to "enable multi-agent" upfront. Accepts a
roster role (`bug-hunter`, `security-scanner`, `refactor-planner`,
`audit-log`) or an explicit `name`/`provider`/`model`. The system
prompt builder detects this tool and injects a "Delegation" guide
teaching the model when to delegate vs stay in-process.

**WebUI polish** — collapsible tool input/output, expandable nested
JSON, copy/download/error-stack toggles, per-message
iterations/tools/elapsed/$ footer, multi-tool turns grouped under one
bubble. Concurrent-run lock prevents two streaming `agent.run` calls
from corrupting session state. WebSocket `connect()` now rejects on
`onerror`/`onclose` before `onopen` instead of hanging the UI forever.

**Test coverage: 2059 tests** across 203 files. Five new dedicated
suites pin the regression duvarı: error classification (T1/T2/T7),
abort-during-tool (T3), partial JSONL read (T6), coordinator races
(T4/T5/M4/M5/T8), cost-bucket disjointness (M2). The plan-mode
preamble has its own 9-test suite for `/steer` and `/goal`.

### What's new in 0.1.10

Additive update — no breaking changes.

**Extended thinking / reasoning stream** — `thinking_delta` events flow
end-to-end from provider SSE through the agent loop to the TUI/WebUI.
OpenAI `reasoning_content`, Anthropic thinking blocks, and Google
thoughts all normalize to the same `StreamEvent` schema.

**`@wrongstack/core` subpath exports** — `execution/`, `coordination/`,
`infrastructure/`, `storage/`, `security/`, `models/`, `sdd/`, and
`observability/` are now independent entrypoints. Deep-import what you
need; deep-imports tree-shake cleanly.

**Tool output size chips** — `tool.executed` events now carry
`outputBytes`, `outputTokens`, and `outputLines` so the TUI can render
inline size chips (`1.2 KB · ~340t · 45 lines`) beside each tool result.

**Child-process env hardening** — `buildChildEnv()` is now the single
canonical implementation in `@wrongstack/core`; the `patch` tool was
the last holdout still spreading `process.env`. `WRONGSTACK_CHILD_ENV_PASSTHROUGH=1`
(defaults off) opts back to the old behaviour.

**4 security fixes + WebUI guards** — MCP SSE reader 256 KB buffer cap,
`replace` symlink traversal prevention, WebUI overlapping-run guard,
WebUI broadcast error handling, and memory-store consolidation backup.

### What's new in 0.1.9

No breaking changes — additive on both the public API and the plugin contract.

**Director orchestration** — LLM-driven multi-agent fleet: one Director
plans, spawns, assigns, asks, and rolls up a fleet of subagents, each
with its own provider, model, context, session, and budget. Opt-in via
`--director`.

- **8 LLM-callable fleet tools** on the leader's tool belt:
  `spawn_subagent`, `assign_task`, `await_tasks`, `ask_subagent`,
  `roll_up`, `terminate_subagent`, `fleet_status`, `fleet_usage`.
  A pre-built 4-agent roster ships: Audit Log, Bug Hunter, Refactor
  Planner, Security Scanner.
- **`/fleet` slash command hub** (status, usage, kill, manifest) +
  `/spawn` flag parser (`--provider`, `--model`, `--name`, `--tools`).
- **FleetBus** fans in per-subagent EventBus events; **FleetUsageAggregator**
  rolls up token/cost; **per-subagent JSONL transcripts** for independent
  replay; **shared fleet scratchpad** for filesystem-mediated coordination.
- **Safety caps**: `maxSpawns` (lifetime limit), `maxSpawnDepth` (nesting
  bound), `DirectorBudgetError` for graceful leader replanning.
- **Audit triage closed**: `AutonomousRunner` tool-call counting fix,
  MCP `_toolsCache` sync, `tool_use` confirm-permission unwrap,
  `scaffold` sync→async I/O migration. See [CHANGELOG.md](CHANGELOG.md).

### What's new in 0.1.7

**`@wrongstack/webui` first npm release** — standalone `webui` binary with
React 19 + Radix + Tailwind frontend, `ws`-backed Node backend reusing
the CLI's boot path. Vim-style `j`/`k` bubble nav, CSS Custom Highlights
API search, inline error stack-trace expander, token-estimate chip,
drag-and-drop file attach, pretty tool-input renderer, Preferences panel.

### What's new in 0.1.6

Forensic-audit security pass: **7 CRITICAL, 16 HIGH, 20 MEDIUM, 9 LOW**
findings closed. See [`SECURITY.md`](SECURITY.md). Headline: **`bash`
tool now sanitizes its child process env** — no more API key leakage
into LLM-generated commands. `WRONGSTACK_BASH_ENV_PASSTHROUGH=1`
opts back to the old behaviour.

## Quick start

```bash
# First run — interactive setup wizard (picks provider + model, saves to config)
wrongstack init

# No config? No problem — the interactive picker launches automatically:
wrongstack          # shows provider list → model list → save prompt → REPL
wrongstack --tui    # same picker, then enters the TUI

# Start coding with the TUI
wrongstack --tui

# Skip all permission prompts (auto-approve every tool call)
wrongstack --tui --yolo

# Use a specific provider and model (skip the picker entirely)
wrongstack --provider openai --model gpt-4.1
wrongstack --provider groq --model llama-3.3-70b-versatile
wrongstack --provider zai-coding-plan --model glm-5.1

# Combine everything: TUI + yolo + custom provider/model
wrongstack --tui --yolo --provider zai-coding-plan --model glm-5.1

# Director fleet orchestration (LLM-driven multi-agent)
wrongstack --director "audit src/ for security issues"

# Single-shot query (no interactive mode)
wrongstack "refactor src/auth.ts to async/await"

# Resume a saved session
wrongstack --resume <session-id>
wrongstack resume <session-id>       # same thing
```

## First-run setup

There are three ways to configure a provider and model:

**1. Interactive wizard** (`wrongstack init`):

```bash
$ wrongstack init
WrongStack init
ℹ Loading provider catalog from models.dev (cached locally)…
Detected API keys for: Anthropic
Provider [anthropic]:
Model [claude-opus-4-7]:
ℹ Found API key in env (ANTHROPIC_API_KEY).
ℹ Wrote C:\Users\you\.wrongstack\config.json
```

**2. Automatic picker** — just run `wrongstack` with no config. An interactive picker lists all supported providers (grouped by wire family, API-key status shown with ●/○), then the models for your chosen provider. Your selection is saved to `~/.wrongstack/config.json` so you only pick once.

**3. CLI flags** — skip all interactivity:

```bash
wrongstack --provider zai-coding-plan --model glm-5.1
```

All three approaches read from `models.dev/api.json`. API keys land in the config encrypted with a key file the CLI generates the first time it needs to encrypt anything.

To add a key later without re-running `init`:

```bash
$ wrongstack auth groq
Enter GROQ_API_KEY:
ℹ Stored encrypted key for groq.
```

## Daily use

```bash
wrongstack "refactor src/auth.ts to async/await"   # single-shot
wrongstack                                          # REPL (or picker if no config)
wrongstack --tui                                    # Ink-based TUI (paste collapse, @-picker, images)
wrongstack --tui --yolo                             # TUI + auto-approve all tool calls
wrongstack --director "audit src/ for security"  # Director fleet orchestration
wrongstack --resume <id>                            # continue a saved session
wrongstack resume <id>                              # same, sugar form
```

### Switching providers and models

`--provider` and `--model` override whatever's in your config. Combine them freely with other flags:

```bash
# Use OpenAI for this session only
wrongstack --provider openai --model gpt-4.1

# Groq for fast iteration
wrongstack --tui --yolo --provider groq --model llama-3.3-70b-versatile

# Any provider from the models.dev catalog (~110 providers)
wrongstack --provider deepseek --model deepseek-chat
wrongstack --provider openrouter --model anthropic/claude-opus-4
wrongstack --provider zai-coding-plan --model glm-5.1

# Or set them permanently in config
wrongstack config
```

You can also switch at runtime inside the REPL or TUI with the `/model` and `/use` slash commands — no restart needed.

### `--yolo` mode

`--yolo` skips **all** permission prompts. Every tool call (`bash`, `write`, `edit`, etc.) runs immediately without asking. Useful for:

- CI pipelines and automated workflows
- Quick iteration when you trust the agent
- Pair programming where you watch the screen and interrupt if needed

```bash
wrongstack --tui --yolo "add unit tests for src/auth.ts"
```

## Three interactive surfaces

**Plain REPL** (default): readline-based, multiline heredoc, slash commands, streaming text. Works everywhere a terminal works.

**TUI** (`--tui`): Ink + React frontend in `@wrongstack/tui`, lazy-loaded — non-TUI users pay no React/Ink import cost. Features wired:

- Multi-line paste collapsed to `[pasted #1] (123 lines)` via bracketed paste mode (`\x1b[?2004h`) plus a chunk-size heuristic fallback
- `@<query>` opens a fuzzy file-picker over the project root, arrow keys to navigate, Enter attaches as `[file #N]`
- `Alt+V` or `/image` reads an image from the clipboard (PowerShell on Windows, `osascript` on macOS, `wl-paste`/`xclip` on Linux), attaches as `[image #N]`
- Image input is routed before the run: native vision models receive the image directly; text-only models can use a registered vision adapter/MCP tool; otherwise the run fails with a clear unsupported-image message.
- **Live status bar**: model · token in/out · cache hit % · cost · run state · `running: <tool> Ns (+N)` while tools execute · 4th line showing top-4 active subagents
- **LiveActivityStrip** above the input: one line per running subagent showing the tool currently in flight, elapsed timer, iteration + tool-call counters, plus the last two compact tool/message summaries. Tool telemetry stays here and in FleetPanel instead of flooding chat history.
- **Esc-to-steer**: mid-flight redirect that aborts the run, terminates the fleet (1.5s cap), and prepends a STEERING preamble (snapshot of in-flight tools, terminated subagents, last partial output + explicit authority grant) to the next user message
- **`/goal <description>`** locks in a relentless autonomous mode — no implicit budget cap, anti-hedge constraints, three-angle persistence
- Streaming text rendered live from the provider's SSE stream
- Signal-safe cleanup: `SIGINT`/`SIGTERM`/`SIGHUP`/`exit` all disable bracketed paste mode on the way out
- Non-TTY guard: refuses to start with exit code 2 when stdin or stdout is piped
- `Home`/`End` keys jump to start/end of the input buffer (parsed from raw stdin CSI sequences since Ink 5.x doesn't surface them)
- Re-entrancy guard on `Enter`: blocks stale second events from terminals that emit `\r\n` as two separate stdin frames, preventing double-submit
- Resize ghost mitigation: `\x1b[J` erase-below-cursor on every resize event prevents leftover live-region lines from persisting in non-alt-screen mode; for heavy resize / split-pane workflows, `--alt-screen` eliminates the issue entirely

**Web UI** (`@wrongstack/webui`): React + Radix + Tailwind frontend with a Node `ws` backend that reuses the same `bootConfig()` / vault / agent assembly the CLI uses. Standalone `webui` binary serves the static bundle on port `3456` and the WebSocket on `3457`. The CLI can also opt in with `wrongstack --webui`. Both paths bind to `127.0.0.1` by default — set `WS_HOST=0.0.0.0` for LAN access. Highlights:

- Topbar status bar mirroring the TUI: ctx% · token in/out · cache hit · cost (click for per-turn breakdown) · live elapsed · iteration counter · streaming chars/sec
- Per-message footer: token usage `42,103→1,287 · $0.0234`, `Pin` / `Edit & resend` / `Retry` / view-raw-markdown, plus a run summary `3 iter · 4 tools · 2.1s · $0.0234` attached to the last assistant bubble of each turn
- Tool bubbles: collapsed one-line summary by default, live `tool.progress` stream while running, side-by-side line-numbered gutter when the output exceeds 25 lines, "Download as file" + Copy on hover
- Sidebar: live TODO snapshot, Pinned panel (scroll-to-bubble), History with search + Today/Yesterday/This week/Earlier grouping + star-to-favourite, drag-to-resize handle
- Welcome screen: no-providers CTA, "Pick back up" recent sessions, recent prompts as one-click refills, four prompt cards by intent (Explore / Build / Debug / Refactor)
- Overlays: `Ctrl+K` command palette, `Ctrl+M` quick model switcher (saved providers + lazy-loaded models), `Ctrl+F` chat search, `?` shortcuts cheat-sheet, `Ctrl+Shift+D` compact density toggle
- Smart-paste hint when dropping > 800 chars, message queue while a run is in-flight (drained one-at-a-time on `run.result`), connection-lost banner with live retry countdown, dynamic favicon badge + optional completion chime when the tab is hidden
- Slash commands grouped by category (Run / Session / Inspect / App) with `↑↓ Tab Enter` keyboard nav and aliases
- Day-separator dividers when transcripts span midnight; tab title carries `{iter} · {session-title} · {project} · WrongStack`

```bash
# Standalone (recommended for the full experience)
webui                          # binds backend to 127.0.0.1:3457, serves UI on 3456
WS_HOST=0.0.0.0 webui          # expose on the LAN

# Or piggy-back on the CLI process
wrongstack --webui
```

## Built-in tools

**33 tools registered out of the box** — 30 from `builtinTools`, 1 context manager (always-on default), and 2 memory tools (`remember`/`forget`, gated by `features.memory`).

| Tool | What it does |
|------|--------------|
| `read` | Read file contents with offset/limit |
| `write` | Write or overwrite a file |
| `edit` | Surgical string replacement in existing files |
| `replace` | Batch regex replacement across matched files |
| `glob` | Find files matching a pattern |
| `grep` | Search file contents with regex |
| `bash` | Run shell commands |
| `exec` | Restricted shell with an allowlist (`node`, `npm`, `pnpm`, …) |
| `fetch` | HTTP fetch with HTML→markdown (localhost blocked by default) |
| `search` | Web search (DuckDuckGo / Google / Bing) |
| `patch` | Apply unified diff patches |
| `json` | Parse and query JSON with dot notation |
| `diff` | Show differences between files or commits |
| `tree` | Display directory structure as ASCII tree |
| `lint` | Run linter (Biome / ESLint / TSLint) |
| `format` | Format code with Biome / Prettier |
| `typecheck` | TypeScript type checking |
| `test` | Run tests with Vitest / Jest / Mocha |
| `install` | Install npm packages |
| `audit` | Security vulnerability audit |
| `outdated` | Check for outdated packages |
| `logs` | Stream or fetch service log files |
| `document` | Generate JSDoc/TSDoc comments |
| `scaffold` | Generate boilerplate from templates |
| `tool_search` / `tool_use` / `batch_tool_use` / `tool_help` | Meta-tooling for tool discovery and orchestration |
| `todo` | Track multi-step tasks |
| `git` | Common git operations |
| `context_manager` | Inspect / trim / compact the in-flight context window |
| `remember` / `forget` | Persist notes across sessions (project- or user-scoped) |

## CLI flags

```
--provider <id>      Override provider (e.g. anthropic, openai, groq)
--model <id>         Override model
--cwd <path>         Project root (default: process.cwd())
--resume <id>        Resume a saved session
--tui                Use the Ink TUI instead of readline REPL
--no-tui             Force-disable the TUI (overrides --tui)
--no-banner          Suppress the startup banner
--no-features        Run with everything off: no MCP, no plugins, no memory tools,
                     no models.dev fetch, no skill discovery. Minimal viable WrongStack.
--yolo               Auto-allow all tool calls (don't ask for confirmation)
--director           Enable Director-based fleet orchestration (LLM-driven
                     subagent planning, spawning, roll-up)
--goal "<task>"      Boot directly into goal mode — TUI auto-enables, the
                     GOAL preamble is injected as the first turn, and the
                     agent works until verifiably complete. Esc/`/steer` to
                     redirect, Ctrl+C to bail. Pair with --director for fleet.
--ask "<text>"       Submit one turn verbatim on TUI boot (no preamble).
                     For scripted shell aliases that pre-populate a question.
--alt-screen         TUI only: render into a separate screen buffer (no native
                     scrollback). Eliminates resize ghost artifacts at the cost
                     of losing terminal history after exit.
--verbose / -v       Log level → debug
--trace              Log level → trace
--log-level <lvl>    Explicit log level
--help / --version   Standard
```

## Subcommands

```bash
wrongstack init           # First-run setup wizard
wrongstack auth <prov>    # Store an API key (prompted, encrypted at rest)
wrongstack sessions       # List saved sessions for this project
wrongstack resume <id>    # Continue a saved session
wrongstack config         # Show / edit config
wrongstack tools          # List registered tools
wrongstack skills         # List discovered skills
wrongstack providers      # ~110 providers grouped by wire family
wrongstack models [prov]  # Models for a provider (default: current)
wrongstack mcp            # Inspect connected MCP servers
wrongstack plugin         # Plugin manifest commands
wrongstack diag           # Diagnostics: provider, tokens, paths
wrongstack usage          # Token + cost totals across sessions
wrongstack projects       # List known project hashes → paths
wrongstack help           # Help text
wrongstack version        # Version
```

Use `/image` or `/paste-image` to attach the current clipboard PNG to the next
message. TUI users can also press `Alt+V`.

## Slash commands (in-REPL)

`/init`, `/diag`, `/stats`, `/help`, `/clear`, `/context`, `/compact`, `/usage`, `/tools`, `/skill`, `/use`, `/model`, `/save`, `/resume`, `/exit`, `/spawn`, `/fleet`, `/agents`, `/steer`, `/goal`, `/director`, `/queue`, `/altscreen`, `/plan`

| Command | Effect |
|---|---|
| `/init` | Create `.wrongstack/AGENTS.md`, the committed project brief loaded into the system prompt; auto-detects build system (package.json / pyproject.toml / go.mod / Cargo.toml / Makefile) and pre-fills build/test/lint/run commands. |
| `/spawn [--provider --model --name --tools] <task>` | Launch a single subagent. No implicit budget cap — runs until done. |
| `/director` | Promote the session to director mode at runtime (must be called before any subagent is spawned). |
| `/fleet status\|usage\|kill\|manifest\|retry\|log\|stream on\|off\|help` | Inspect and control the subagent fleet. `log <id>` summarises a transcript; `log <id> raw` dumps it. |
| `/agents` | Print the current fleet roster (running, idle, completed) with kind chips for failures. |
| `/steer <new direction>` | Mid-flight redirect. Aborts the active iteration, terminates running subagents, drops the queue, sends the new direction with a STEERING preamble (context + authority) prepended. Same effect as pressing **Esc** then typing. |
| `/goal <description>` | Lock in a goal the agent must drive to a verifiable finish — full autonomy preamble, anti-hedge constraints, three-angle persistence. Only Esc / `/steer` / Ctrl+C / `/fleet kill` can stop it. |
| `/queue` | Show, clear, or delete entries from the in-flight message queue. |
| `/altscreen on\|off` | Toggle the terminal alt-screen buffer. Default OFF (native scroll); `on` for full-screen mode. |
| `/plan` | View / append to the per-session plan JSON file. |
| `/model` | Two-step provider → model picker. |
| `/use`, `/context`, `/compact`, `/usage`, `/tools`, `/skill` | Switch modes, inspect context, compact, show usage, list tools/skills. |

Context-window modes are separate from persona modes. Use `/context mode`
to list policies and `/context mode frugal|balanced|deep|archival` to switch
how aggressively the session trims history. `frugal` is the most token
friendly, `deep` preserves more recent turns, and `archival` favors steady
decision-preserving compaction.

### Mid-flight controls (cheat sheet)

| Key / Command | What it does |
|---|---|
| **Esc** (while busy) | Soft interrupt — abort agent, terminate fleet, drop queue, set "steering pending". Next message you type carries a STEERING preamble explaining what was in flight. |
| `/steer <text>` | Same as Esc + typing, in one shot. Works when Esc is eaten by tmux / outer terminal multiplexer, and also when the agent is idle. |
| `/goal <text>` | "No force stops this" mode — full autonomy contract. Only Esc / Ctrl+C interrupt. |
| **Ctrl+C** × 1 | Cancel current iteration + terminate fleet (1.5s cap). |
| **Ctrl+C** × 2 | Force-exit Ink loop. |
| **Ctrl+C** × 3 | Hard `process.exit(130)`. |
| `/fleet kill <id>` | Stop one specific subagent. |

## Catalog commands

```bash
wrongstack providers              # ~110 providers grouped by wire family
wrongstack providers --all        # include unsupported families (needs plugin)
wrongstack models                 # models for current provider
wrongstack models google          # models for any provider id from models.dev
wrongstack models refresh         # force-refresh the 24h cache
```

`●` = your env has a key for this provider · `○` = configure to use it.

## Providers (4 wire families + 1 stub)

| Family | Transport | Providers in models.dev |
|--------|-----------|------------------------|
| `anthropic` | Native Claude API + SSE | Anthropic, MiniMax, Kimi, Google Vertex (Anthropic) |
| `openai` | Native OpenAI Chat Completions + SSE | OpenAI, Perplexity Agent, Vivgrid |
| `openai-compatible` | OpenAI-spec endpoints + SSE | ~100 providers: Mistral, Groq, DeepSeek, OpenRouter, Together, xAI, Cerebras, Ollama, Fireworks, Moonshot, GLM, Alibaba, … |
| `google` | Gemini `:streamGenerateContent?alt=sse` | Google AI Studio |
| `unsupported` | Needs plugin | Cohere, Bedrock, Vertex (non-Anthropic), Azure |

All four supported families implement **real streaming** end-to-end: provider `stream()` is the source of truth, `complete()` is just `aggregateStream(stream(...))`. Mid-stream aborts preserve any partial assistant text already received.

## Configuration

### Environment variables

| Variable | Description |
|----------|-------------|
| `<PROVIDER>_API_KEY` | API key for the provider (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) |
| `WRONGSTACK_FETCH_ALLOW_PRIVATE` | Set to `1` to allow localhost / private IPs in the `fetch` tool |
| `WRONGSTACK_BASH_ENV_PASSTHROUGH` | Set to `1` to disable the bash-tool env allowlist (legacy unsafe mode — see [SECURITY.md](SECURITY.md)) |

### Config file (`~/.wrongstack/config.json`)

```jsonc
{
  "version": 1,
  "provider": "anthropic",
  "model": "claude-opus-4-7",
  "providers": {
    "anthropic": { "apiKey": "enc:v1:<iv>:<tag>:<ciphertext>" }
  },
  "features": {
    "mcp": true,
    "plugins": true,
    "memory": true,
    "modelsRegistry": true,
    "skills": true
  },
  "plugins": []
}
```

`apiKey`-like fields (matched by the regex `/apikey|authtoken|bearer|secret|password|refreshtoken|sessionkey|access[_-]?token|private[_-]?key/i`) are auto-encrypted on first contact. Plaintext keys in older config files get migrated transparently on boot — you'll see a `[wstack] Encrypted N plaintext secret(s) in …` notice if migration ran.

### Vision MCP adapters

Text-only models can still work with images when an MCP server exposes a safe,
read-only image-understanding tool. For example, Z.AI's Vision MCP server
publishes tools such as `image_analysis`, `extract_text_from_screenshot`,
`diagnose_error_screenshot`, and `understand_technical_diagram`.

The easiest path is a built-in preset:

```bash
wstack mcp add zai-vision --enable
wstack mcp add minimax-vision --enable
```

```jsonc
{
  "features": { "mcp": true },
  "mcpServers": {
    "zai-mcp-server": {
      "name": "zai-mcp-server",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@z_ai/mcp-server@latest"],
      "env": {
        "Z_AI_API_KEY": "enc:v1:<iv>:<tag>:<ciphertext>",
        "Z_AI_MODE": "ZAI"
      },
      "permission": "auto",
      "allowedTools": [
        "image_analysis",
        "extract_text_from_screenshot",
        "diagnose_error_screenshot",
        "understand_technical_diagram",
        "analyze_data_visualization",
        "ui_diff_check"
      ]
    }
  }
}
```

When the active model lacks native vision, WrongStack writes pasted clipboard
images to a temporary local file if the MCP tool expects `path` /
`image_path` / `image_url` / `file_path`, invokes the adapter, replaces the
image with the returned text description, and removes the temp file after the
call.

MiniMax's MCP server fits the same adapter shape. Its `understand_image` tool
accepts a `prompt` plus `image_url`, and `image_url` may be either an HTTP URL
or a local file path.

```jsonc
{
  "features": { "mcp": true },
  "mcpServers": {
    "MiniMax": {
      "name": "MiniMax",
      "transport": "stdio",
      "command": "uvx",
      "args": ["minimax-coding-plan-mcp", "-y"],
      "env": {
        "MINIMAX_API_KEY": "enc:v1:<iv>:<tag>:<ciphertext>",
        "MINIMAX_MCP_BASE_PATH": "./.wrongstack/minimax-output",
        "MINIMAX_API_HOST": "https://api.minimax.io",
        "MINIMAX_API_RESOURCE_MODE": "url"
      },
      "permission": "auto",
      "allowedTools": ["understand_image"]
    }
  }
}
```

### Project-level (`<project>/.wrongstack/AGENTS.md`)

Commit this file to share project conventions with the agent across all developers:

```
// Conventions for this repo
- Always run tests after editing
- Use pnpm, not npm
- PR titles follow conventionalcommits.org
```

## Four contracts

**1. Minimal kernel.** `Container`, `Pipeline`, `EventBus`, `RunController`, and the token table total **505 lines**. The agent loop adds another **525 lines**. Everything else is replaceable.

**2. Zero non-overridable behavior.** 16 services bound through `Container` (Logger, TokenCounter, SessionStore, MemoryStore, PermissionPolicy, Compactor, PathResolver, ConfigLoader, Renderer, InputReader, ErrorHandler, RetryPolicy, SkillLoader, SystemPromptBuilder, SecretScrubber, ModelsRegistry). 6 pipelines as middleware chains (`request`, `response`, `toolCall`, `userInput`, `assistantOutput`, `contextWindow`). Tools, providers, MCP servers, and slash commands all live in registries.

**3. Standalone sufficiency.** Works with 33 built-in tools, 4 wire-family transports, permission policy, and a curated system prompt — no plugins required.

**4. Layered, not monolithic.** `--no-features` flips off MCP, plugins, memory tools, models.dev fetch, and skill discovery. What's left is the kernel + agent + tools + a hand-configured provider. The minimal-viable WrongStack runs offline with no network calls at startup.

## Layering with `--no-features`

```bash
# Fully offline: no MCP servers, no plugins, no memory persistence,
# no models.dev fetch, no skill discovery. Provider family must be
# declared explicitly in providers[<id>].family.
wrongstack --no-features --provider anthropic --model claude-opus-4-7 "..."
```

Each feature flag is independent; you can keep skills on while turning MCP off, or run a CI job with just `features.modelsRegistry: false` to avoid the startup network call.

## Mode system

Agents can operate in different modes that inject role-specific system prompts. 8 built-in modes: `default`, `code-reviewer`, `code-auditor`, `architect`, `debugger`, `tester`, `devops`, `refactorer`.

```ts
import { DefaultModeStore } from '@wrongstack/core';
import { createModeTool } from '@wrongstack/tools';

const modeStore = new DefaultModeStore({ directory: '~/.wrongstack/modes' });
const modeTool = createModeTool(modeStore);

await modeTool.execute({ action: 'set', mode: 'code-reviewer' });
```

## Multi-agent

Run multiple agents in parallel with done-condition looping:

```ts
// Autonomous — runs until done condition
const runner = new AutonomousRunner({
  agent,
  context,
  doneCondition: { type: 'iterations', maxIterations: 100 },
});

// Multi-agent coordinator — task orchestration.
// NOTE: no defaultBudget here. Subagents get a budget only when the
// orchestrator (delegate / spawn_subagent) explicitly passes one.
// The Agent's auto-extending iteration loop covers runaway protection.
const coordinator = new DefaultMultiAgentCoordinator({
  coordinatorId: 'main',
  maxConcurrent: 8,
  doneCondition: { type: 'all_tasks_done' },
});

await coordinator.spawn({ id: 'w1', name: 'Worker', role: 'reviewer' });
await coordinator.assign({ id: 't1', description: 'Review auth module' });
```

### Director (fleet orchestration)

Opt into LLM-driven fleet orchestration with `--director`. The Director
model plans, spawns, assigns, asks, and rolls up a fleet of subagents —
each with its own provider, model, and budget. The 8 fleet tools
(`spawn_subagent`, `assign_task`, `await_tasks`, `ask_subagent`,
`roll_up`, `terminate_subagent`, `fleet_status`, `fleet_usage`) are on
the leader's tool belt from the first message.

```bash
# Launch a director with the pre-built 4-agent roster
wrongstack --director "audit src/ for security issues"

# Fleet management from inside the REPL
/fleet status          # task progress per subagent
/fleet usage           # token + cost breakdown
/fleet log <id>        # compact transcript summary
/fleet log <id> raw    # full per-subagent JSONL dump
/fleet kill <id>       # stop a specific subagent
/fleet manifest        # full fleet snapshot

# Spawn custom subagents
/spawn --provider groq --model llama-3.3-70b --name reviewer --tools read,grep,edit
```

#### Architecture

```
                  ┌─────────────────────────────────────────────┐
                  │                  TUI (Ink)                  │
                  │  History · LiveActivityStrip · FleetPanel   │
                  │  Esc-to-steer · /goal · /steer · Ctrl+C     │
                  └────────────┬────────────────────────────────┘
                               │ subagent.spawned · task_started
                               │ subagent.tool_executed (always-on bridge)
                               │ task_completed (with SubagentError envelope)
                               ▼
        ┌──────────────────────────────────────────────────────┐
        │                   Host EventBus                      │
        └──────┬───────────────────────────────────────┬───────┘
               │                                       │
               ▼                                       ▼
   ┌─────────────────────────┐         ┌────────────────────────────────┐
   │   Leader Agent (Director)│        │   FleetBus (director-only)     │
   │   ─────────────────────  │        │   ───────────────────────────  │
   │   • System prompt + 8    │        │   Per-subagent event fan-in:   │
   │     fleet tools          │        │   tool.* · iteration.* ·       │
   │   • Plans · spawns ·     │        │   provider.{text,thinking}_*   │
   │     assigns · awaits     │        │   compaction.* · token.*       │
   │   • autoExtendLimit=true │        │                                │
   │   • No hidden budget cap │        │   FleetUsageAggregator rolls   │
   └──────┬───────────────────┘        │   tokens + cost per subagent   │
          │                            └────────────────────────────────┘
          │ spawn_subagent / assign_task / ask_subagent / terminate
          ▼
   ┌────────────────────────────────────────────────────────────────┐
   │         DefaultMultiAgentCoordinator                            │
   │  ─────────────────────────────────────────────────────────────  │
   │  • Dispatch loop with terminating-Set race guard                │
   │  • SubagentBudget (only applied when orchestrator passes one)   │
   │  • classifySubagentError → 14-kind discriminated union          │
   │  • Per-subagent AbortController · per-task dispose hook         │
   └─────────┬──────────────────────────────────────────────────────┘
             │ runner(task, ctx)
             ▼
   ┌────────────────────────────────────────────────────────────────┐
   │  AgentSubagentRunner (per-task)                                 │
   │  ─────────────────────────────────────────────────────────────  │
   │  • Fresh Agent + Context + EventBus (full isolation)            │
   │  • Multi-provider: any provider/model per subagent              │
   │  • Bridges tool.executed → host bus (compact TUI surface)       │
   │  • tool.progress → checkTimeout (cooperative wall-clock bust)   │
   │  • Empty-response / tool-failed guards → kind-classified errors │
   │  • Per-task JSONL writer, closed via dispose() in finally       │
   └────────────────────────────────────────────────────────────────┘
            │              │              │              │
            ▼              ▼              ▼              ▼
       Subagent A     Subagent B     Subagent C     Subagent D
       (anthropic)    (openai)       (groq)         (zai)
       opus-4-7       gpt-4.1        llama-70b      glm-5.1
            │              │              │              │
            └──────────────┴──────┬───────┴──────────────┘
                                  ▼
                    Per-subagent JSONL transcripts on disk
                    + manifest.json + director-state.json
```

#### Autonomous `/goal` mode

The `/goal <description>` slash command turns the leader into a relentless
worker. It prepends a four-section preamble to the next agent turn:

```
[GOAL — LOCKED IN. You will work on this until it is verifiably done.

YOUR GOAL: <user text fenced>

AUTHORITY YOU HAVE:
  • Spawn as many subagents as the work needs (parallel + recursive).
  • Use any provider/model per subagent.
  • Unlimited tool calls + iterations. Agent loop auto-extends every 100.
  • Retry failed tools; switch providers mid-run if rate-limited.

WHAT "DONE" MEANS — non-negotiable:
  • Named artifact (passing test, file at a specific path, fixed bug
    verified by re-running the failing case).
  • A 10-second user verification recipe.
  • No hedges ("looks like it should work", "I believe this fixes it").

WHAT IS NOT DONE — never report as completion:
  • Unhandled error · empty result accepted · "should I continue?" hedge
  • Partial progress dressed up as success
  • A failed subagent TaskResult you didn't respond to

PERSISTENCE PROTOCOL:
  • Blocked? Try at least 3 angles (different tool inputs, different
    roles, different providers) before reporting.
  • Tool failed? Read the error, alter the input, try again.
  • Subagent returned useless output? Respawn with tighter prompt.

BEGIN.]
```

The unlimited-budget machinery (no implicit `maxToolCalls` / `maxIterations`
caps; `autoExtendLimit=true` on every Agent; coordinator `maxConcurrent`
8, `maxSpawnDepth` 5) makes the contract enforceable. Only the user
interrupts — Esc / `/steer` redirect, Ctrl+C / `/fleet kill <id>` bail
out.

#### What kills a subagent (and how it surfaces)

| Cause | Surfaced as | Retryable? |
|---|---|---|
| Per-tool timeout (300s default) | `kind: 'budget_timeout'` | true |
| Wall-clock budget (only if orchestrator set `timeoutMs`) | `kind: 'budget_timeout'` | true |
| Tool-call cap (only if orchestrator set `maxToolCalls`) | `kind: 'budget_tool_calls'` | false |
| Iteration cap (only if orchestrator set `maxIterations`) | `kind: 'budget_iterations'` | false |
| Provider 429 | `kind: 'provider_rate_limit'`, `backoffMs: 5000` | true |
| Provider 5xx | `kind: 'provider_5xx'`, `backoffMs: 3000` | true |
| Provider 401/403 | `kind: 'provider_auth'` | false |
| Tool returned `ok:false` and agent didn't recover | `kind: 'tool_failed'` | false |
| LLM ended with no text and no tool calls | `kind: 'empty_response'` | false |
| Parent abort (Esc / Ctrl+C / `/fleet kill`) | `kind: 'aborted_by_parent'` | false |
| Bridge transport error | `kind: 'bridge_failed'` | false |
| Context length exceeded | `kind: 'context_overflow'` | false |

Every failure includes the `cause` (original error name + message + stack)
so diagnostics survive even when `kind === 'unknown'`. The delegate tool
output exposes `errorKind` / `retryable` / `backoffMs` as top-level
fields so the calling LLM can branch on classification.

See [`docs/director-architecture.md`](docs/director-architecture.md) for
the full design — FleetBus, prompt layering, safety caps, per-subagent
JSONL transcripts, and the shared scratchpad.

## Spec-Driven Development

Full workflow: `SpecParser` → `TaskGenerator` → `TaskTracker` → `TaskFlow`

```ts
const parser = new SpecParser();
const spec = parser.parse(markdownSpec);
const analysis = parser.analyze(spec);

const tracker = new TaskTracker({ store });
const generator = new TaskGenerator({ taskTracker: tracker });
await generator.generateFromSpec(spec);

const flow = new TaskFlow({ tracker });
await flow.execute({ executeTask: async (task) => { /* ... */ } });
```

### Bundled skills

`audit-log`, `bug-hunter`, `git-flow`, `multi-agent`, `node-modern`, `prompt-engineering`, `react-modern`, `refactor-planner`, `sdd`, `security-scanner`, `typescript-strict` — discovered in this order: project → user → bundled, with first-seen winning on name collisions.

## Sessions

Every run writes a `<id>.jsonl` append-only event log under `~/.wrongstack/projects/<sha256>/sessions/`. On close, a tiny `<id>.summary.json` manifest is written alongside (title, model, provider, tokenTotal) so `wstack sessions` lists hundreds of past runs without re-parsing each JSONL — listing is O(N) stats, not O(N) full parses.

Resume picks up exactly where the previous run left off, replays the events into `Context.messages`, and writes a `session_resumed` marker. Orphan `tool_result` events (where the matching `tool_use` is missing) emit a `session.damaged` event so the session can be flagged for repair instead of silently corrupting the replay.

## Encrypted secrets

API keys and MCP auth tokens are encrypted with **AES-256-GCM** using a 32-byte key kept at `~/.wrongstack/.key` (mode `0600` on POSIX). The format is `enc:v1:<iv>:<tag>:<ciphertext>`. Different invocations produce different ciphertexts for the same plaintext (random IV per encryption).

The CLI auto-migrates any plaintext keys it finds in `config.json` on every boot. Field detection is regex-based, so `refreshToken`, `sessionKey`, `client_secret`, `private_key`, `bearer`, etc. all get picked up automatically; `publicKey` is on a hard-coded override list (it's a key, but it's not a secret).

## Observability events

The `EventBus` carries **28 typed events**:

- **Session**: `session.started`, `session.ended`, `session.damaged`
- **Iteration**: `iteration.started`, `iteration.completed`, `iteration.limit_reached`
- **Provider**: `provider.response`, `provider.text_delta`, `provider.thinking_delta`, `provider.tool_use_start`, `provider.tool_use_stop`, `provider.retry`, `provider.error`
- **Tool**: `tool.started`, `tool.progress`, `tool.confirm_needed`, `tool.executed` (closes the gap between "model decided to call a tool" and "tool finished"; carries `outputBytes` / `outputTokens` / `outputLines` for inline size chips)
- **Token / compaction**: `token.threshold`, `token.cost_estimate_unavailable`, `compaction.fired`, `compaction.failed`
- **Subagent lifecycle**: `subagent.spawned` (carries `transcriptPath` to the JSONL on disk), `subagent.task_started`, `subagent.task_completed` (carries the full `SubagentError` envelope on failure), `subagent.tool_executed` (always-on per-tool bridge so the TUI can update compact live agent surfaces regardless of director mode)
- **MCP**: `mcp.server.connected`, `mcp.server.reconnected`, `mcp.server.disconnected`
- **Error**: `error`

Subscribe with `events.on(name, fn)` or `events.once(name, fn)`; listeners that throw are caught and logged, never re-thrown.

## Filesystem layout

```
~/.wrongstack/                              # everything developer-level
  config.json                               # global config (provider + encrypted keys)
  .key                                      # AES-256-GCM key (mode 0600)
  cache/models.dev.json                     # 24h TTL provider catalog
  memory.md                                 # user-global agent notes
  skills/                                   # user-global skills
  history                                   # REPL history
  logs/wrongstack.log                       # ops log
  projects/<sha256-of-project-root>/        # per-project state
    memory.md                               # project agent notes
    sessions/<id>.jsonl                     # session events (append-only)
    sessions/<id>.summary.json              # cached summary for fast listing
    trust.json                              # permission policy
    meta.json                               # links hash → path

<your-project>/.wrongstack/                # only committed artifacts
  AGENTS.md                                 # project conventions (shared via git)
  skills/                                   # project-local skills (shared via git)
```

The project tree stays clean — sessions, trust rules, logs, and caches never pollute it.

## Extending with plugins

Manage plugins from the CLI:

```bash
wstack plugin list
wstack plugin status
wstack plugin official
wstack plugin install telegram
wstack plugin add @wrongstack/telegram
wstack plugin disable @wrongstack/telegram
wstack plugin enable @wrongstack/telegram
wstack plugin remove @wrongstack/telegram
```

Inside REPL/TUI, use the same flow from the slash menu:

```text
/plugin official
/plugin install telegram
/plugin disable telegram
/plugin enable telegram
```

`telegram` and `lsp` are bundled official aliases for
`@wrongstack/telegram` and `@wrongstack/plug-lsp`. Config changes are written
immediately; restart WrongStack to load or unload plugin code in the current
session. Official plugin `install` adds the bundled package to config; it does
not run npm.

Or edit `config.plugins` manually:

```jsonc
// ~/.wrongstack/config.json
{
  "version": 1,
  "provider": "anthropic",
  "model": "claude-opus-4-7",
  "features": { "plugins": true },
  "plugins": ["@yourorg/wrongstack-plug-typecheck"],
  "extensions": {
    "your-plugin-name": {
      "option": "value"
    }
  }
}
```

A plugin declares `apiVersion: "^1.0"` and gets the full `PluginAPI`: container, pipelines, events, tool/provider/MCP registries, config, logger. See `packages/core/src/plugin/` for the contract. Optional dependencies (`optionalDeps`) are silently skipped if not loaded; required ones (`dependsOn`) throw at boot. See [Plugin Management](docs/plugin-management.md) for slash/CLI enable-disable-install workflows and config layout.

## Packages

| Package | Purpose | README |
|---------|---------|--------|
| `@wrongstack/core` | Kernel, agent, types, registries, plugin contract | [packages/core](packages/core/README.md) |
| `@wrongstack/runtime` | Default runtime implementations, host composition helpers, extension pack contracts | [packages/runtime](packages/runtime/README.md) |
| `@wrongstack/providers` | Anthropic/OpenAI/OpenAI-compatible/Google wire adapters + SSE | [packages/providers](packages/providers/README.md) |
| `@wrongstack/tools` | 33 built-in tools | [packages/tools](packages/tools/README.md) |
| `@wrongstack/mcp` | MCP server registry + reconnection logic | [packages/mcp](packages/mcp/README.md) |
| `@wrongstack/cli` | REPL, subcommands, slash commands, terminal renderer | [packages/cli](packages/cli/README.md) |
| `@wrongstack/tui` | Ink-based TUI (paste collapse, @-picker, image paste) — lazy-loaded behind `--tui` | [packages/tui](packages/tui/README.md) |
| `@wrongstack/plug-lsp` | LSP plugin: exposes language server protocol tools (`wrongstack-lsp-setup` binary) | [packages/plug-lsp](packages/plug-lsp/README.md) |
| `@wrongstack/telegram` | Telegram plugin: send/read Telegram messages, notifications, and `/telegram:*` slash commands | [packages/telegram](packages/telegram/README.md) |
| `@wrongstack/webui` | Standalone web UI (React + Radix + Tailwind frontend, `ws`-backed Node backend reusing the CLI's boot path) — `webui` binary, also reachable via `wrongstack --webui` | — |

## Architecture

```
CLI       → REPL, renderer, slash commands, subcommands
TUI       → Ink frontend (lazy-loaded behind --tui)
Steering  → Esc / /steer / /goal — mid-flight redirect + autonomous lock-in
Director  → Fleet orchestration (LLM-driven, opt-in via --director)
Agent     → loop, context, system prompt, permission, compaction, autoExtendLimit
Tools     → ToolExecutor (parallel/sequential/smart strategies, abort-safe)
Runtime   → Default host assembly + WrongStackPack extension composition
Kernel    → Container · Pipeline · EventBus · RunController (the 4 primitives)
Provider  → 4 wire families, factories built from ModelsRegistry, real SSE
Models    → models.dev/api.json fetched + cached + classified
```

### Observability layering — four ways to see what the fleet is doing

```
                    ┌───────────────────────────────────┐
                    │       Human view (TUI)            │
                    │   • LiveActivityStrip (top-4)     │
                    │   • FleetPanel (full roster)      │
                    │   • Chat: agent text + lifecycle   │
                    │   • Kind chips on failures        │
                    └─────────────┬─────────────────────┘
                                  │
                  ┌───────────────┴────────────────┐
                  │                                │
                  ▼                                ▼
         ┌──────────────────┐          ┌────────────────────────┐
         │  Host EventBus   │          │   FleetBus             │
         │  (always-on)     │          │   (director-only)      │
         │  Lifecycle +     │          │   Full per-subagent    │
         │  per-tool bridge │          │   event stream         │
         └──────────────────┘          └────────────────────────┘
                                  ▲                ▲
                                  │                │
                              ┌───┴────────────────┴───┐
                              │  Per-subagent EventBus │
                              │  (each task)           │
                              └─────────────┬──────────┘
                                            │
                                            ▼
                              ┌──────────────────────────┐
                              │  Per-subagent JSONL on   │
                              │  disk (full transcript)  │
                              │  /fleet log <id> [raw]   │
                              │  ~/.wrongstack/.../*.jsonl│
                              └──────────────────────────┘
```

State lives in the agent layer only. Kernel, providers, and the models registry are stateless within a single run (the registry persists its cache).

For the full walk-through — including the L1-A reactive `ConversationState`,
how the six pipelines fire per turn, and how plugins / MCP / observability
plug in — see [`docs/architecture.md`](docs/architecture.md).

## Contributor docs

| Doc | What it covers |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Package layout, the kernel primitives (Container/Pipeline/EventBus/RunController), the agent lifecycle, the L1-A reactive split |
| [`docs/director-architecture.md`](docs/director-architecture.md) | Director orchestration: FleetBus, prompt layering, safety caps, per-subagent JSONL, shared scratchpad |
| [`docs/plugin-author-guide.md`](docs/plugin-author-guide.md) | Building a plugin end-to-end: capabilities, dependencies, configSchema, teardown contract, testing |
| [`docs/plugin-management.md`](docs/plugin-management.md) | User-facing plugin workflows: list/add/remove/enable/disable and config layout |
| [`docs/provider-author-guide.md`](docs/provider-author-guide.md) | Adding an LLM provider declaratively via `WireFormatConfig`, stream-state design, vendor quirks |
| [`docs/tool-author-guide.md`](docs/tool-author-guide.md) | Writing a tool: streaming `executeStream`, permission semantics, `cleanup` vs `registerAbortHook`, the mtime contract |

## Benchmarks

`pnpm bench` runs all `*.bench.ts` files via a separate vitest config
and writes results to `bench-results.json` (gitignored). The current
suite covers compactor hot paths, token estimation, JSON-schema
validation, and the system prompt builder. See
[`vitest.bench.config.ts`](vitest.bench.config.ts).

## Status

- **2059 tests passing** across 203 test files (~13 s, 1 skipped)
- Coverage thresholds enforced in `vitest.config.ts`: ≥85 % lines / ≥85 % functions / ≥70 % branches / ≥82 % statements
- All workspace packages build clean with TypeScript strict + `noUncheckedIndexedAccess`
- Node 22+ only, ESM-only, no CommonJS bundles
- CI gate: `pnpm typecheck && pnpm build && pnpm test` all required
- Threat model and adversary trust assumptions: [`SECURITY.md`](SECURITY.md)

## License

MIT © 2026 ECOSTACK TECHNOLOGY OÜ — see [LICENSE](LICENSE).
