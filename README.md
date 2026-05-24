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
# or
pnpm install -g wrongstack
```

This pulls in the full stack — `@wrongstack/core`, `@wrongstack/runtime`, `@wrongstack/providers`, `@wrongstack/tools`, `@wrongstack/mcp`, `@wrongstack/plug-lsp`, and `@wrongstack/tui`. The TUI is shipped but lazy-loaded behind `--tui`, so plain-REPL users pay no React/Ink import cost at startup. The web-based UI (`@wrongstack/webui`) is available as a separate binary (`webui`).

After install, `wrongstack` is on your `PATH`. (`wstack` works too — it's an alias.)

### What's new in 0.6.6

**`/sdd` — Spec-Driven Development workflow.** New slash command in
`packages/cli/src/slash-commands/sdd.ts` that guides the agent through
the SDD loop: `parse` → `analyze` → `generate` → `track` → `execute`.
Accepts a markdown spec file path as argument (e.g. `/sdd docs/my-feature.md`).
The command reads the spec, generates tasks via `TaskGenerator`, and
displays task status inline. Built on `SpecParser`, `TaskTracker`,
`TaskGenerator`, and `TaskFlow` from `@wrongstack/core/sdd`.

**`/goal pause` and `/goal resume`.** Two new subcommands for the goal
system:
- `/goal pause` — sets `goalState: 'paused'` in `goal.json`. The eternal
  engine sees this on its next iteration start (via `goalState !== 'active'`
  guard) and exits gracefully after the current iteration finishes — no
  AbortController kill, no work torn mid-task.
- `/goal resume` — flips `goalState` back to `'active'`. The engine resumes
  on the next `/autonomy eternal` invocation or immediately if already running.

**`IterationStage` pipeline + TUI stage chip.** `EternalAutonomyEngine`
now calls an `onStage` callback at each phase transition
(`decide → execute → reflect → sleep`). The CLI wires a `stageListeners`
Set and exposes `subscribeEternalStage` to the TUI, which dispatches into
`state.eternalStage` for live rendering. The TUI status bar shows the
current phase label (e.g. `⟳ DECIDE`, `⚡ EXECUTE`, `◎ REFLECT`) updating
every tick.

**`GoalFile.goalState` field.** `goal-store.ts` now models the goal
lifecycle with three states: `'active' | 'paused' | 'done'`. All existing
goal files continue working — missing `goalState` defaults to `'active'`
for backwards compatibility.

**`SlashCommandRegistry` double-register guard relaxed.** Built-in slash
commands that re-register (e.g. TUI + CLI both mounting the same command)
now silently no-op instead of throwing. This protects against React Strict
Mode double-mounts in development and plugin hot-reload scenarios. Third-party
commands using the same bare name from different owners still throw to
prevent accidental shadowing.

For earlier release notes, see [CHANGELOG.md](CHANGELOG.md).

### What's new in 0.6.5

**`/autonomy parallel` — parallel subagent fan-out mode.** The
autonomy engine now has two modes: `eternal` (single-leader loop) and
`parallel` (leader drives, N subagents execute tasks simultaneously).
`parallel` mode uses the new `ParallelEternalEngine` which implements
sense → decide → fan-out → aggregate → loop. Each tick decomposes the
goal into up to 4 parallel tasks (configurable, max 16), spawns that
many subagents via `DefaultMultiAgentCoordinator`, awaits all results,
and writes a journal entry. `[GOAL_COMPLETE]` in any subagent's output
stops the engine cleanly. The `/autonomy` command now handles both
`eternal` and `parallel`; `/fleet journal` prints recent entries.

**TUI parallel status chip.** The TUI status bar shows a `⟳ PARALLEL`
chip in amber when the parallel engine is running, updating every
tick with the live iteration count.

**`/fleet` extended.** Gains `spawn <role> [count]` to spawn N
subagents of a role, `terminate <subagentId>` to stop one, and `kill`
to stop all. Status output surfaces subagent current task, elapsed
time, and per-slot status during parallel mode.

**`maxConcurrent: 8`** in `DefaultMultiAgentCoordinator` (raised from
2) to support the higher fan-out density parallel mode requires.

**Session store safety.** `append` now catches circular JSON and writes
an error marker instead of crashing; `truncateFromStart` prunes the
oldest 20 % when the JSONL exceeds 50 MB rather than attempting a
precise trim.

For earlier release notes, see [CHANGELOG.md](CHANGELOG.md).

### What's new in 0.6.4

**Official plugin collection — `@wrongstack/plugins`.** Ten ready-to-use
plugins ship in a single new workspace package, each available via a
subpath export (`@wrongstack/plugins/<name>`):

- `auto-doc` — generate JSDoc / TSDoc comments for source files
- `git-autocommit` — stage and commit with conventional-commit messages
- `shell-check` — wrap ShellCheck over a file list or a directory scan
- `cost-tracker` — listen to `provider.response` events and report
  per-model token usage and estimated cost
- `file-watcher` — watch paths and emit `file-watcher:changed` events
- `web-search` — cached DuckDuckGo search + a URL→markdown fetcher
- `json-path` — JSONPath-style queries and mutations
- `cron` — schedule recurring actions via `beforeIteration` /
  `afterIteration` extension hooks
- `template-engine` — `{{var}}` / `{{#if}}` / `{{#each}}` expansion,
  with a system-prompt contributor that advertises the tools
- `semver-bump` — conventional-commit-driven version bumps and
  changelog generation

Build hygiene: every plugin now type-checks under `strict` +
`noUncheckedIndexedAccess`, uses the real plugin API
(`api.onEvent('provider.response', …)` instead of mutating the
read-only response pipeline, `AgentExtension` for `beforeIteration` /
`afterIteration`, `SystemPromptContributor` as a function), and ships
proper `Record<string, unknown>` typings on every tool `execute`.

### What's new in 0.6.1

**Reliability + correctness pass.** Tool cleanup contract hardened
in `ToolExecutor`: when a tool threw mid-execution AND the combined
signal was aborted, the `finally` path could call `cleanup()` twice
and overwrite the real error with the abort reason — the original
throw is now preserved. The `provider.tool_use_stop` event carries
the tool `name` (was id-only), so subscribers no longer have to
maintain their own in-flight tool map. Type safety in `/mcp`
mutations fixed (`Record<string, MCPServerConfig>` annotations on
`runRemove` / `runEnable` / `runDisable`). Latent `require()` in
`outdated.ts` replaced with a static ESM import. Fragile tests
skipped with TODO markers naming the missing fixtures; one git test
now uses real `git init` instead of a hand-built `.git/HEAD`.

### What's new in 0.6.0

**Eternal autonomy — `/autonomy eternal` + persistent `/goal`.** Set a
mission with `/goal <text>` (persists to `.wrongstack/goal.json`),
turn the engine on with `/autonomy eternal` (or launch with
`--eternal`), and the agent drives sense → decide → execute → reflect
cycles until you stop it (Esc / Ctrl+C / `/autonomy stop`). The
hybrid decide pipeline walks pending todos → dirty git → LLM
brainstorm, so the loop produces useful work even when no task is
queued. TUI shows a red `ETERNAL` chip; the WebUI receives a live
`eternal.iteration` WS broadcast per cycle.

**Unified `/goal`.** `/goal` shows status + journal,
`/goal <text>` (or `/goal set <text>`) persists *and* injects the
full-autonomy lock-in preamble into the next turn, `/goal clear`
stops the engine, `/goal journal [N]` prints the FIFO ring (default
25, cap 500). The TUI's preamble-only `/goal` is removed; the CLI
builtin now handles both behaviors — fixes a `goal is already
registered` crash on TUI mount.

**+272 additive tests** (3091 passing total) covering previously
untested isolated modules — circuit breaker, process registry,
observability event bridge, health registry, config-secrets walker,
regex-guard ReDoS protection, JSON schema validator, and the
`/yolo` / `/mode` / `/compact` / `/goal` / `/autonomy` / `/commit`
glue. No source changes; pure coverage uplift.

For earlier release notes, see [CHANGELOG.md](CHANGELOG.md).

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
wrongstack --provider openai --model gpt-5.5
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
wrongstack --provider openai --model gpt-5.5

# Groq for fast iteration
wrongstack --tui --yolo --provider groq --model llama-3.3-70b-versatile

# Any provider from the models.dev catalog (~110 providers)
wrongstack --provider deepseek --model deepseek-v4-pro
wrongstack --provider openrouter --model anthropic/claude-opus-4-7
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

**TUI** (`--tui`): Ink + React frontend, lazy-loaded. Key features:

- Multi-line paste collapse, `@<query>` fuzzy file picker, clipboard image paste (`Alt+V`)
- Live status bar: model · tokens · cache hit · cost · `running: <tool>` while tools execute
- **LiveActivityStrip**: tool in flight + elapsed timer per running subagent
- **Esc-to-steer**: aborts run, terminates fleet, prepends STEERING preamble to your next message
- **`/goal <description>`**: locks in full-autonomy mode — no implicit budget cap
- Signal-safe cleanup, non-TTY guard, re-entrancy guard on Enter, resize ghost mitigation

**Web UI** (`@wrongstack/webui`): React + Radix + Tailwind frontend with a Node `ws` backend. Standalone `webui` binary serves on `3456/3457`; CLI can opt in with `wrongstack --webui`. Highlights:

- Topbar status bar: ctx% · tokens · cache hit · cost · elapsed · iteration
- Per-message footer: token usage, Pin / Edit & resend / Retry
- Tool bubbles: live `tool.progress` stream, collapsible gutter, Download/Copy on hover
- Sidebar: live TODO snapshot, Pinned panel, History with grouping + search
- Overlays: `Ctrl+K` command palette, `Ctrl+M` model switcher, `Ctrl+F` chat search, `?` shortcuts
- Slash commands with keyboard nav, day-separator dividers, dynamic tab title

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

`/init`, `/diag`, `/stats`, `/help`, `/clear`, `/context`, `/compact`, `/usage`, `/tools`, `/skill`, `/use`, `/model`, `/save`, `/resume`, `/exit`, `/spawn`, `/fleet`, `/agents`, `/steer`, `/goal`, `/director`, `/queue`, `/altscreen`, `/plan`, `/autonomy`, `/yolo`, `/mode`, `/image`, `/plugin`, `/telegram`

| Command | Effect |
|---|---|
| `/init` | Create `.wrongstack/AGENTS.md`, the committed project brief loaded into the system prompt; auto-detects build system (package.json / pyproject.toml / go.mod / Cargo.toml / Makefile) and pre-fills build/test/lint/run commands. |
| `/spawn [--provider --model --name --tools] <task>` | Launch a single subagent. No implicit budget cap — runs until done. |
| `/director` | Promote the session to director mode at runtime (must be called before any subagent is spawned). |
| `/fleet status\|usage\|kill\|manifest\|retry\|log\|stream on\|off\|help` | Inspect and control the subagent fleet. `log <id>` summarises a transcript; `log <id> raw` dumps it. |
| `/agents` | Print the current fleet roster (running, idle, completed) with kind chips for failures. |
| `/steer <new direction>` | Mid-flight redirect. Aborts the active iteration, terminates running subagents, drops the queue, sends the new direction with a STEERING preamble (context + authority) prepended. Same effect as pressing **Esc** then typing. |
| `/goal <description>` | Lock in a goal the agent must drive to a verifiable finish — persists to `.wrongstack/goal.json` and injects the full-autonomy preamble into the next turn. Subcommands: `/goal` (status + journal), `/goal clear` (stop engine), `/goal journal [N]` (recent FIFO entries). Pairs with `/autonomy eternal` for indefinite runs. Only Esc / `/steer` / Ctrl+C / `/fleet kill` can stop it. |
| `/queue` | Show, clear, or delete entries from the in-flight message queue. |
| `/altscreen on\|off` | Toggle the terminal alt-screen buffer. Default OFF (native scroll); `on` for full-screen mode. |
| `/plan` | View / append to the per-session plan JSON file. Six actions: `show|add|start|done|remove|clear`. Items have `open` / `in_progress` / `done` status. Mirrored to disk; surfaces `📋 ⌛N ☐N ✓N` chip in TUI status bar. |
| `/autonomy on\|off\|suggest\|eternal\|stop\|toggle` | Self-driving agent mode. `on` picks the next logical step and continues after each turn; `suggest` shows next-step suggestions without executing; `eternal` runs the sense → decide → execute → reflect loop indefinitely against the persistent `/goal` (use `stop` to halt). TUI shows `∞ AUTO` / `∞ SUGGEST` / `ETERNAL` chip. |
| `/yolo on\|off\|toggle` | Flip YOLO mode (auto-approve all tool calls) on or off without restarting. `/yolo` alone shows current status. TUI shows `⚠ YOLO` chip. |
| `/mode` | Switch agent persona mode. Eight built-in modes: `default`, `code-reviewer`, `code-auditor`, `architect`, `debugger`, `tester`, `devops`, `refactorer`. Modes inject role-specific system prompts; stored in `~/.wrongstack/modes/` and can be extended with custom prompts. |
| `/model` | Two-step provider → model picker. Switch at runtime without restart. |
| `/image` or `/paste-image` | Attach the current clipboard PNG to the next message. TUI users can also press `Alt+V`. |
| `/context mode <policy>` | Switch context-window mode: `balanced`, `frugal`, `deep`, `archival`. Use `/context mode` to list policies. `repair` to fix damaged tool-call adjacency. |
| `/plugin install\|disable\|enable\|remove\|official <name>` | Manage plugins from REPL/TUI. `install` adds bundled package to config; does not run npm. Restart to load/unload plugin code. |
| `/telegram send\|read\|chat\|attach` | Telegram plugin commands. `send <chatId> <message>`, `read <chatId> [limit]`, `chat` list recent chats, `attach <file>` send file. |
| `/use`, `/compact`, `/usage`, `/tools`, `/skill`, `/save`, `/resume`, `/help`, `/clear`, `/stats`, `/diag`, `/exit` | Switch modes, compact context, show usage, list tools/skills, save session, resume session, help, clear screen, stats, diagnostics, exit REPL. |

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

Text-only models work with images via MCP server adapters (e.g. `image_analysis`, `understand_image`):

```bash
wstack mcp add zai-vision --enable
wstack mcp add minimax-vision --enable
```

When the active model lacks native vision, WrongStack writes clipboard images to a temp file, invokes the adapter, replaces the image with the returned text, then removes the temp file.
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
/spawn --provider groq --model llama-3.3-70b-versatile --name reviewer --tools read,grep,edit
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
       opus-4-7       gpt-5.5        llama-70b      glm-5.1
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
| Per-tool timeout | `kind: 'budget_timeout'` | ✓ |
| Wall-clock budget | `kind: 'budget_timeout'` | ✓ |
| Tool-call cap | `kind: 'budget_tool_calls'` | — |
| Iteration cap | `kind: 'budget_iterations'` | — |
| Provider 429 | `kind: 'provider_rate_limit'` | ✓ |
| Provider 5xx | `kind: 'provider_5xx'` | ✓ |
| Provider 401/403 | `kind: 'provider_auth'` | — |
| Tool `ok:false` | `kind: 'tool_failed'` | — |
| Empty response | `kind: 'empty_response'` | — |
| Parent abort | `kind: 'aborted_by_parent'` | — |
| Context overflow | `kind: 'context_overflow'` | — |

Every failure includes `cause` (error name + message + stack). The delegate tool exposes `errorKind` / `retryable` / `backoffMs` so the calling LLM can branch on classification.

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

The `EventBus` carries **28 typed events** across Session, Iteration, Provider, Tool, Token/compaction, Subagent lifecycle, MCP, and Error categories. Subscribe with `events.on(name, fn)` or `events.once(name, fn)`; listeners that throw are caught and logged, never re-thrown.

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
| [`docs/slash/`](docs/slash/) | Full reference for every built-in slash command |
| [`docs/subcommands/`](docs/subcommands/) | Full reference for every `wstack <subcommand>` |
| [`docs/director-architecture.md`](docs/director-architecture.md) | Director orchestration: FleetBus, prompt layering, safety caps, per-subagent JSONL, shared scratchpad |
| [`docs/plugin-author-guide.md`](docs/plugin-author-guide.md) | Building a plugin end-to-end: capabilities, dependencies, configSchema, teardown contract, testing |
| [`docs/plugin-management.md`](docs/plugin-management.md) | User-facing plugin workflows: list/add/remove/enable/disable and config layout |
| [`docs/provider-author-guide.md`](docs/provider-author-guide.md) | Adding an LLM provider declaratively via `WireFormatConfig`, stream-state design, vendor quirks |
| [`docs/tool-author-guide.md`](docs/tool-author-guide.md) | Writing a tool: streaming `executeStream`, permission semantics, `cleanup` vs `registerAbortHook`, the mtime contract |
| [`docs/yolo-mode.md`](docs/yolo-mode.md) | YOLO (auto-approve) mode: permission pipeline, runtime toggle, trust file interaction, subagent policy, security trade-offs |
| [`docs/skills.md`](docs/skills.md) | Writing skills: frontmatter format, discovery layers, description quality, token budget, examples |
| [`docs/configuration.md`](docs/configuration.md) | Full config reference: every field with type, default, and example |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | Common issues, diagnosis steps, `wstack diag` usage, exit codes, reset commands |

## Benchmarks

`pnpm bench` runs all `*.bench.ts` files via a separate vitest config
and writes results to `bench-results.json` (gitignored). The current
suite covers compactor hot paths, token estimation, JSON-schema
validation, and the system prompt builder. See
[`vitest.bench.config.ts`](vitest.bench.config.ts).

## Examples

See [`examples/`](examples/) for 6 categories of working examples:

| # | Example | What it demonstrates |
|---|---------|---------------------|
| 01 | [Basic usage](examples/01-basic/) | Single-shot, REPL, session resume, YOLO |
| 02 | [Tool usage](examples/02-tools/) | File editing, code search, git, tests |
| 03 | [Multi-provider](examples/03-providers/) | Switching providers, custom endpoints |
| 04 | [MCP integration](examples/04-mcp/) | Connecting MCP servers, using MCP tools |
| 05 | [Multi-agent](examples/05-multi-agent/) | Director fleet, delegation, subagents |
| 06 | [Real-world workflows](examples/06-real-world/) | Refactoring, testing, debugging, audits |

## Status

- **3091 tests passing** across 259 test files (~20 s, 4 skipped)
- Coverage thresholds enforced in `vitest.config.ts`: ≥85 % lines / ≥85 % functions / ≥70 % branches / ≥82 % statements
- All workspace packages build clean with TypeScript strict + `noUncheckedIndexedAccess`
- Node 22+ only, ESM-only, no CommonJS bundles
- CI gate: `pnpm typecheck && pnpm build && pnpm test` all required
- Threat model and adversary trust assumptions: [`SECURITY.md`](SECURITY.md)

## License

MIT © 2026 ECOSTACK TECHNOLOGY OÜ — see [LICENSE](LICENSE).
