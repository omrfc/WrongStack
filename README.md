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

This pulls in the full stack — `@wrongstack/core`, `@wrongstack/providers`, `@wrongstack/tools`, `@wrongstack/mcp`, `@wrongstack/plug-lsp`, and `@wrongstack/tui`. The TUI is shipped but lazy-loaded behind `--tui`, so plain-REPL users pay no React/Ink import cost at startup. The web-based UI (`@wrongstack/webui`) is available as a separate binary (`webui`).

After install, `wrongstack` is on your `PATH`. (`wstack` works too — it's an alias.)

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
- `Alt+V` reads an image from the clipboard (PowerShell on Windows, `osascript` on macOS, `wl-paste`/`xclip` on Linux), attaches as `[image #N]`
- Live status bar: model · token in/out · cache hit % · cost · run state · `running: <tool> Ns (+N)` while tools execute
- Streaming text rendered live from the provider's SSE stream
- Signal-safe cleanup: `SIGINT`/`SIGTERM`/`SIGHUP`/`exit` all disable bracketed paste mode on the way out
- Non-TTY guard: refuses to start with exit code 2 when stdin or stdout is piped

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

## Slash commands (in-REPL)

`/init`, `/diag`, `/stats`, `/help`, `/clear`, `/context`, `/compact`, `/usage`, `/tools`, `/skill`, `/use`, `/model`, `/save`, `/resume`, `/exit`, `/spawn`, `/fleet`, `/agents`

`/init` scaffolds `.wrongstack/AGENTS.md` for the project, detecting your build system (package.json / pyproject.toml / go.mod / Cargo.toml / Makefile) and pre-filling the build/test/lint/run commands. `/spawn` launches a subagent (supports `--provider`, `--model`, `--name`, `--tools` flags). `/fleet` inspects and controls the subagent fleet (status, usage, kill, manifest). `/agents` shows the current fleet roster.

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
| `openai-compatible` | OpenAI-spec endpoints + SSE | ~100 providers: Groq, DeepSeek, OpenRouter, Together, xAI, Cerebras, Ollama, Fireworks, Moonshot, GLM, Alibaba, … |
| `google` | Gemini `:streamGenerateContent?alt=sse` | Google AI Studio |
| `unsupported` | Needs plugin | Mistral, Cohere, Bedrock, Vertex (non-Anthropic), Azure |

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

// Multi-agent coordinator — task orchestration
const coordinator = new DefaultMultiAgentCoordinator({
  coordinatorId: 'main',
  maxConcurrent: 4,
  doneCondition: { type: 'all_tasks_done' },
});

await coordinator.spawn({ id: 'w1', name: 'Worker', role: 'reviewer' });
await coordinator.assign({ id: 't1', description: 'Review auth module' });
```

### Director (fleet orchestration)

Opt into LLM-driven fleet orchestration with `--director`. The Director
model plans, spawns, assigns, asks, and rolls up a fleet of subagents —
each with its own provider, model, and budget. The 8 fleet tools
(`spawn_subagent`, `assign_task`, …) are on the leader's tool belt from
the first message.

```bash
# Launch a director with the pre-built 4-agent roster
wrongstack --director "audit src/ for security issues"

# Fleet management from inside the REPL
/fleet status          # task progress per subagent
/fleet usage           # token + cost breakdown
/fleet kill <id>       # stop a specific subagent
/fleet manifest        # full fleet snapshot

# Spawn custom subagents
/spawn --provider groq --model llama-3.3-70b --name reviewer --tools read,grep,edit
```

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

The `EventBus` carries **24 typed events**: `session.started`, `session.ended`, `session.damaged`, `iteration.started`, `iteration.completed`, `iteration.limit_reached`, `provider.response`, `provider.text_delta`, `provider.tool_use_start`, `provider.tool_use_stop`, `provider.retry`, `provider.error`, `tool.started`, `tool.progress`, `tool.confirm_needed`, `tool.executed` (closes the gap between "model decided to call a tool" and "tool finished" — the TUI uses these to render the live "running: <tool> Ns" indicator), `token.threshold`, `token.cost_estimate_unavailable`, `compaction.fired`, `compaction.failed`, `mcp.server.connected`, `mcp.server.reconnected`, `mcp.server.disconnected`, and `error`.

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

Drop a plugin in `config.plugins`:

```jsonc
// ~/.wrongstack/config.json
{
  "version": 1,
  "provider": "anthropic",
  "model": "claude-opus-4-7",
  "plugins": ["@yourorg/wrongstack-plug-typecheck"]
}
```

A plugin declares `apiVersion: "^1.0"` and gets the full `PluginAPI`: container, pipelines, events, tool/provider/MCP registries, config, logger. See `packages/core/src/plugin/` for the contract. Optional dependencies (`optionalDeps`) are silently skipped if not loaded; required ones (`dependsOn`) throw at boot.

## Packages

| Package | Purpose | README |
|---------|---------|--------|
| `@wrongstack/core` | Kernel, agent, defaults, types, registries, plugin contract | [packages/core](packages/core/README.md) |
| `@wrongstack/providers` | Anthropic/OpenAI/OpenAI-compatible/Google wire adapters + SSE | [packages/providers](packages/providers/README.md) |
| `@wrongstack/tools` | 33 built-in tools | [packages/tools](packages/tools/README.md) |
| `@wrongstack/mcp` | MCP server registry + reconnection logic | [packages/mcp](packages/mcp/README.md) |
| `@wrongstack/cli` | REPL, subcommands, slash commands, terminal renderer | [packages/cli](packages/cli/README.md) |
| `@wrongstack/tui` | Ink-based TUI (paste collapse, @-picker, image paste) — lazy-loaded behind `--tui` | [packages/tui](packages/tui/README.md) |
| `@wrongstack/plug-lsp` | LSP plugin: exposes language server protocol tools (`wrongstack-lsp-setup` binary) | [packages/plug-lsp](packages/plug-lsp/README.md) |
| `@wrongstack/webui` | Standalone web UI (React + Radix + Tailwind frontend, `ws`-backed Node backend reusing the CLI's boot path) — `webui` binary, also reachable via `wrongstack --webui` | — |

## Architecture

```
CLI       → REPL, renderer, slash commands, subcommands
TUI       → Ink frontend (lazy-loaded behind --tui)
Director  → Fleet orchestration (LLM-driven, opt-in via --director)
Agent     → loop, context, system prompt, permission, compaction
Tools     → ToolExecutor (parallel/sequential/smart strategies, abort-safe)
Kernel    → Container · Pipeline · EventBus · RunController (the 4 primitives)
Provider  → 4 wire families, factories built from ModelsRegistry, real SSE
Models    → models.dev/api.json fetched + cached + classified
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
| [`docs/provider-author-guide.md`](docs/provider-author-guide.md) | Adding an LLM provider declaratively via `WireFormatConfig`, stream-state design, vendor quirks |
| [`docs/tool-author-guide.md`](docs/tool-author-guide.md) | Writing a tool: streaming `executeStream`, permission semantics, `cleanup` vs `registerAbortHook`, the mtime contract |

## Benchmarks

`pnpm bench` runs all `*.bench.ts` files via a separate vitest config
and writes results to `bench-results.json` (gitignored). The current
suite covers compactor hot paths, token estimation, JSON-schema
validation, and the system prompt builder. See
[`vitest.bench.config.ts`](vitest.bench.config.ts).

## Status

- **1903 tests passing** across 183 test files (~13 s, 1 skipped)
- Coverage thresholds enforced in `vitest.config.ts`: ≥85 % lines / ≥85 % functions / ≥70 % branches / ≥82 % statements
- All 8 packages build clean with TypeScript strict + `noUncheckedIndexedAccess`
- Node 22+ only, ESM-only, no CommonJS bundles
- CI gate: `pnpm typecheck && pnpm build && pnpm test` all required
- Threat model and adversary trust assumptions: [`SECURITY.md`](SECURITY.md)

## License

MIT © 2026 ECOSTACK TECHNOLOGY OÜ — see [LICENSE](LICENSE).
