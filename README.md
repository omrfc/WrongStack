# WrongStack

> Built on the wrong stack. Shipped anyway.

A CLI AI coding agent that runs in your terminal. It reads your code, edits files, runs commands, and reasons through bugs — while you stay in control of every permission. It drives autonomous goal loops, parallel subagent fan-out, and multi-agent Director orchestration; guides Spec-Driven Development cycles; and ships with 36 built-in tools, 12 bundled skills, 10 official plugins, and ~110 providers from models.dev — all with AES-256-GCM encrypted secrets and per-tool permission policies.

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

---

## Features

### Three interactive surfaces

**Plain REPL** (default): readline-based, multiline heredoc, slash commands, streaming text. Works everywhere a terminal works.

**TUI** (`--tui`): Ink + React frontend, lazy-loaded. Key features:

- Multi-line paste collapse, `@<query>` fuzzy file picker, clipboard image paste (`Alt+V`)
- Live status bar: model · tokens · cache hit · cost · `running: <tool>` while tools execute
- **LiveActivityStrip**: tool in flight + elapsed timer per running subagent
- **Esc-to-steer**: aborts run, terminates fleet, prepends STEERING preamble to your next message
- **`/goal <description>`**: locks in full-autonomy mode — no implicit budget cap
- Signal-safe cleanup, non-TTY guard, re-entrancy guard on Enter, resize ghost mitigation
- Real-time stage chip: `⟳ DECIDE` / `⚡ EXECUTE` / `◎ REFLECT` updates every tick during eternal/parallel runs

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

### 36 built-in tools

All tools are registered out of the box — no plugin required.

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
| `remember` / `forget` | Persist notes across sessions (project- or user-scoped, gated by `features.memory`) |
| `codebase-index` | Build / update the SQLite symbol index (incremental; multi-language) |
| `codebase-search` | BM25-ranked search over indexed symbol names, signatures, and doc comments |
| `codebase-stats` | Summary of the current symbol index |

### Autonomy engine

The engine has two modes, both launched via `/autonomy`:

**`eternal`** — single-leader goal-driven loop. Runs `decide → execute → reflect → sleep` cycles against the persistent `/goal` until you stop it (Esc / `/steer` / Ctrl+C / `/autonomy stop`). Force-enables YOLO. Hybrid decide pipeline walks pending todos → dirty git → LLM brainstorm, so the loop produces useful work even with no queued task. Each phase transition calls the `onStage` callback — the TUI renders the live stage chip (`⟳ DECIDE`, `⚡ EXECUTE`, `◎ REFLECT`) updating every tick. TUI shows a red `ETERNAL` chip; WebUI receives a live `eternal.iteration` WS broadcast per cycle.

**`parallel`** — leader drives, N subagents fan out simultaneously. `ParallelEternalEngine` decomposes the goal into up to `parallelSlots` tasks per tick (default 4, max 16), spawns that many subagents via `DefaultMultiAgentCoordinator`, awaits all results, aggregates, and writes a journal entry. `[GOAL_COMPLETE]` in any subagent's output stops the engine cleanly. `maxConcurrent: 8` supports the higher fan-out density. TUI shows an amber `⟳ PARALLEL` chip with the live iteration count.

Both engines persist state to `goal.json`. Both can be paused and resumed without losing work: `/goal pause` sets `goalState: 'paused'` — the engine exits gracefully after the current iteration finishes (no AbortController kill, no work torn mid-task); `/goal resume` flips `goalState` back to `'active'`.

### Goal system

`/goal <text>` persists to `~/.wrongstack/projects/<hash>/goal.json` and injects a full-autonomy preamble into the next turn:

```
[GOAL — LOCKED IN. You will work on this until it is verifiably done.

YOUR GOAL: <user text>

AUTHORITY: Spawn unlimited subagents · Use any provider/model · Unlimited tool calls + iterations
           Agent loop auto-extends every 100 iterations. Retry failed tools; switch providers on 429.

WHAT "DONE" MEANS: Named artifact (passing test, file at a path, fixed bug verified by re-running)
                   A 10-second user verification recipe. No hedges.

WHAT IS NOT DONE: Unhandled error · empty result · "should I continue?" · partial progress as success

PERSISTENCE: Blocked? Try 3 angles. Tool failed? Read error, alter input, retry.
             Subagent useless? Respawn with tighter prompt.

BEGIN.]
```

`/goal` shows status + journal. `/goal clear` stops the engine. `/goal journal [N]` prints the FIFO ring (default 25, cap 500). Goal state lives in `goalState: 'active' | 'paused' | 'done'`.

### Multi-agent fleet + Director

**Fleet tools** (8 on the Director's belt from first message): `spawn_subagent`, `assign_task`, `await_tasks`, `ask_subagent`, `roll_up`, `terminate_subagent`, `fleet_status`, `fleet_usage`.

**`/fleet`** command: `status` — task progress per subagent · `usage` — token + cost breakdown · `kill <id>` — stop one subagent · `kill` — stop all · `manifest` — full fleet snapshot · `log <id>` — transcript summary · `log <id> raw` — full JSONL dump · `journal` — recent parallel engine entries · `spawn <role> [count]` — spawn N subagents of a role · `terminate <subagentId>` — stop one · `retry <id>` — re-spawn a failed subagent · `stream on|off` — toggle live output streaming.

**`/spawn [--provider --model --name --tools] <task>`** — launch a single subagent. No implicit budget cap; runs until done.

**`/director`** — promote the session to Director mode at runtime (must be called before any subagent is spawned).

**`/autonomy parallel`** — LLM-driven fan-out mode described above.

**Subagent failure taxonomy** (14-kind discriminated union): `budget_timeout` (✓ retryable), `budget_tool_calls`, `budget_iterations`, `provider_rate_limit` (✓), `provider_5xx` (✓), `provider_auth`, `tool_failed`, `empty_response`, `aborted_by_parent`, `context_overflow`. Every failure includes `cause` (error name + message + stack). The delegate tool exposes `errorKind` / `retryable` / `backoffMs` so the calling LLM can branch on classification.

Architecture: Host EventBus (always-on bridge) → Leader Agent (Director) + FleetBus (director-only fan-in) → `DefaultMultiAgentCoordinator` → `AgentSubagentRunner` per task (fresh Agent + Context + EventBus, full isolation) → per-subagent JSONL transcripts on disk.

**46-agent roster + smart dispatcher.** The Director draws from a 46-role agent catalog; a smart dispatcher routes each task to the best-matching role instead of spawning generic clones. The TUI fleet monitor (**Ctrl+F**) shows per-subagent status and a fleet-wide token gauge, and auto-extended budgets surface as a `⚡ extended ×N` badge across all fleet UIs.

**`--director` flag** launches the full fleet roster from the CLI directly:
```bash
wrongstack --director "audit src/ for security issues"
```

### Spec-Driven Development (`/sdd`)

The `/sdd <path-to-spec.md>` slash command guides the agent through the SDD loop: `parse` → `analyze` → `generate` → `track` → `execute`. Built on `SpecParser`, `TaskTracker`, `TaskGenerator`, and `TaskFlow` from `@wrongstack/core/sdd`. Reads a markdown spec file, generates tasks via `TaskGenerator`, and displays task status inline.

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

### Plugin ecosystem — `@wrongstack/plugins`

Ten ready-to-use plugins ship in one package, each available via a subpath export (`@wrongstack/plugins/<name>`):

| Plugin | Tools | Notes |
|--------|-------|-------|
| `auto-doc` | `auto_doc`, `auto_doc_preview` | JSDoc / TSDoc comment generation |
| `git-autocommit` | `git_autocommit`, `git_stage`, `git_status_summary` | Conventional-commit messages |
| `shell-check` | `shellcheck_run`, `shellcheck_scan` | ShellCheck wrapper |
| `cost-tracker` | `cost_summary`, `cost_reset`, `cost_export` | Token usage + cost per model via `provider.response` events |
| `file-watcher` | `watch_start`, `watch_stop`, `watch_list` | Emits `file-watcher:changed` events |
| `web-search` | `web_search`, `web_fetch` | Cached DuckDuckGo + URL→markdown |
| `json-path` | `jsonpath_query`, `jsonpath_mutate` | JSONPath-style queries and mutations |
| `cron` | `cron_schedule`, `cron_list`, `cron_cancel` | Recurring actions via `beforeIteration` / `afterIteration` hooks |
| `template-engine` | `render_template`, `template_variables` | `{{var}}` / `{{#if}}` / `{{#each}}` expansion + system-prompt contributor |
| `semver-bump` | `semver_bump`, `changelog_update` | Conventional-commit-driven version bumps |

All plugins type-check under `strict` + `noUncheckedIndexedAccess`, use the real plugin API (`api.onEvent` not pipeline mutation), register `AgentExtension` for iteration hooks, and ship `Record<string, unknown>` typings on every tool `execute`.

Manage from CLI or REPL:
```bash
wstack plugin list
wstack plugin install telegram
wstack plugin official
wstack plugin disable telegram
wstack plugin enable telegram
wstack plugin remove telegram
```
`telegram` and `lsp` are bundled aliases for `@wrongstack/telegram` and `@wrongstack/plug-lsp`.

### Provider catalog (~110 providers, 4 wire families + 1 stub)

| Family | Transport | Providers |
|--------|-----------|-----------|
| `anthropic` | Native Claude API + SSE | Anthropic, MiniMax, Kimi, Google Vertex (Anthropic) |
| `openai` | Native OpenAI Chat Completions + SSE | OpenAI, Perplexity Agent, Vivgrid |
| `openai-compatible` | OpenAI-spec endpoints + SSE | ~100 providers: Mistral, Groq, DeepSeek, OpenRouter, Together, xAI, Cerebras, Ollama, Fireworks, Moonshot, GLM, Alibaba, … |
| `google` | Gemini `:streamGenerateContent?alt=sse` | Google AI Studio |
| `unsupported` | Needs plugin | Cohere, Bedrock, Vertex (non-Anthropic), Azure |

All four supported families implement **real streaming** end-to-end: `provider.stream()` is the source of truth, `complete()` is `aggregateStream(stream(...))`. Mid-stream aborts preserve any partial assistant text already received. Catalog comes from `models.dev/api.json` — no hardcoded pricing, no hardcoded model names.

**Vision MCP adapters**: text-only models work with images via MCP server adapters:
```bash
wstack mcp add zai-vision --enable
wstack mcp add minimax-vision --enable
```
When the active model lacks native vision, WrongStack writes clipboard images to a temp file, invokes the adapter, replaces the image with the returned text, then removes the temp file.

### Session persistence + resume

Every run writes a `<id>.jsonl` append-only event log under `~/.wrongstack/projects/<sha256>/sessions/`. On close, a tiny `<id>.summary.json` manifest (title, model, provider, tokenTotal) is written alongside — `wrongstack sessions` lists hundreds of past runs without re-parsing each JSONL (O(N) stats, not O(N) full parses). `session_resumed` marker written on resume. Orphan `tool_result` events (missing matching `tool_use`) emit `session.damaged` event so the session can be flagged for repair.

### Encrypted secrets

API keys and MCP auth tokens encrypted with **AES-256-GCM** using a 32-byte key kept at `~/.wrongstack/.key` (mode `0600` on POSIX). Format: `enc:v1:<iv>:<tag>:<ciphertext>`. Random IV per encryption — same plaintext yields different ciphertexts. The CLI auto-migrates plaintext keys it finds in `config.json` on every boot. Field detection is regex-based (`/apikey|authtoken|bearer|secret|password|refreshtoken|sessionkey|access[_-]?token|private[_-]?key/i`); `publicKey` is on a hard-coded override list.

### Mode system (8 personas)

Agents can operate in different modes that inject role-specific system prompts: `default`, `code-reviewer`, `code-auditor`, `architect`, `debugger`, `tester`, `devops`, `refactorer`. Modes live in `~/.wrongstack/modes/` and can be extended with custom prompts.

```ts
import { DefaultModeStore } from '@wrongstack/core';
import { createModeTool } from '@wrongstack/tools';

const modeStore = new DefaultModeStore({ directory: '~/.wrongstack/modes' });
const modeTool = createModeTool(modeStore);
await modeTool.execute({ action: 'set', mode: 'code-reviewer' });
```

### Context window policies

Switch how aggressively the session trims history: `balanced` (default), `frugal` (most token-friendly), `deep` (preserves more recent turns), `archival` (steady decision-preserving compaction). Use `/context mode` to list policies and switch at runtime. `repair` to fix damaged tool-call adjacency.

### Observability — 28 typed events

`EventBus` carries events across Session, Iteration, Provider, Tool, Token/compaction, Subagent lifecycle, MCP, and Error categories. Subscribe with `events.on(name, fn)` or `events.once(name, fn)`; listeners that throw are caught and logged, never re-thrown.

Four-layer observability:
- **Human view (TUI)**: LiveActivityStrip (top-4), FleetPanel, lifecycle chips on failures
- **Host EventBus** (always-on): lifecycle + per-tool bridge
- **FleetBus** (director-only): full per-subagent event stream — `tool.*`, `iteration.*`, `provider.{text,thinking}_*`, `compaction.*`, `token.*`
- **Per-subagent JSONL on disk**: `/fleet log <id>` summarises, `/fleet log <id> raw` dumps full transcript

### Security

- **Permission policy** (`trust.json`): per-tool allow/deny, persisted to disk, applies to subagents
- **YOLO mode** (`--yolo` or `/yolo`): skips all permission prompts — for CI and trusted workflows
- **Bash tool env allowlist**: `WRONGSTACK_BASH_ENV_PASSTHROUGH=1` disables the allowlist (legacy unsafe mode — see `SECURITY.md`)
- **`WRONGSTACK_FETCH_ALLOW_PRIVATE=1`**: enables localhost/private IPs in the `fetch` tool
- **AES-256-GCM** encryption for all secrets at rest
- Threat model and adversary trust assumptions in [`SECURITY.md`](SECURITY.md)

### Bundled skills (12)

`audit-log`, `bug-hunter`, `git-flow`, `multi-agent`, `node-modern`, `prompt-engineering`, `react-modern`, `refactor-planner`, `sdd`, `security-scanner`, `typescript-strict` — discovered in order: project → user → bundled, with first-seen winning on name collisions.

### `--no-features` minimal kernel

Flips off MCP, plugins, memory tools, models.dev fetch, and skill discovery. What's left: kernel (`Container` + `Pipeline` + `EventBus` + `RunController`, 505 lines) + agent (525 lines) + 36 tools + permission policy + curated system prompt. The minimal-viable WrongStack runs offline with no network calls at startup. Provider family must be declared explicitly in config when using this mode.

---

## What's new in 0.8.0

- **Agents monitor overlay (`Ctrl+G` or `/agents monitor|on|off`).** A minimised agents panel above the input, independent of the full fleet monitor (`Ctrl+F`).
  Subagent `provider.text_delta` text lands in the leader's chat history when enabled.
- **`/agents stream on|off`.|`/agents stream on|off`.
  sessions, specs, task-graphs, plan, and memory now live under a per-machine
  hashed project directory; the only repo-committed file is
  `.wrongstack/AGENTS.md`.
- **Vault key protected from silent loss.** A corrupt or wrong-size `.key`
  file now raises an error instead of being overwritten with a fresh key
  (which would have destroyed all encrypted secrets).

For earlier release notes, see [CHANGELOG.md](CHANGELOG.md).

## Quick start

```bash
# First run — interactive setup wizard
wrongstack init

# No config? Interactive picker launches automatically:
wrongstack          # provider list → model list → save prompt → REPL
wrongstack --tui    # same, then enters TUI

# TUI + YOLO (skip all permission prompts)
wrongstack --tui --yolo

# Specific provider/model — skip the picker
wrongstack --provider groq --model llama-3.3-70b-versatile

# Director fleet orchestration
wrongstack --director "audit src/ for security issues"

# Single-shot query
wrongstack "refactor src/auth.ts to async/await"

# Resume a saved session
wrongstack --resume <session-id>
wrongstack resume <session-id>       # same
```

### First-run setup

Three ways to configure:

1. **`wrongstack init`** — interactive wizard, saves to `~/.wrongstack/config.json`
2. **Automatic picker** — just run `wrongstack` with no config; saves after selection
3. **CLI flags** — `wrongstack --provider <id> --model <id>` — skips all interactivity

Add a key later: `wrongstack auth groq` (prompts, encrypts, stores).

### Switching providers at runtime

Use `/model` (two-step picker) or `/use <provider> <model>` — no restart needed.

```bash
wrongstack --provider openai --model gpt-5.5
wrongstack --provider deepseek --model deepseek-v4-pro
wrongstack --provider openrouter --model anthropic/claude-opus-4-7
```

## CLI flags

```
--provider <id>      Override provider (e.g. anthropic, openai, groq)
--model <id>         Override model
--cwd <path>         Project root (default: process.cwd())
--resume <id>        Resume a saved session
--tui                Use the Ink TUI instead of readline REPL
--no-tui             Force-disable the TUI (overrides --tui)
--no-banner          Suppress the startup banner
--no-features        Minimal kernel — no MCP, plugins, memory, models.dev, skills
--yolo               Auto-allow all tool calls (don't ask for confirmation)
--director           Enable Director-based fleet orchestration (LLM-driven subagent planning)
--goal "<task>"      Boot directly into goal mode — GOAL preamble injected, TUI auto-enabled
--ask "<text>"       Submit one turn verbatim on TUI boot (no preamble)
--alt-screen         TUI only: render into a separate screen buffer (no native scrollback)
--verbose / -v       Log level → debug
--trace              Log level → trace
--log-level <lvl>    Explicit log level
--help / --version   Standard
```

## Slash commands

`/init` `/diag` `/stats` `/help` `/clear` `/context` `/compact` `/usage` `/tools` `/skill` `/use` `/model` `/save` `/resume` `/exit` `/spawn` `/fleet` `/agents` `/steer` `/goal` `/director` `/queue` `/altscreen` `/plan` `/autonomy` `/yolo` `/mode` `/image` `/plugin` `/telegram` `/sdd`

| Command | Effect |
|---|---|
| `/init` | Create `.wrongstack/AGENTS.md` — auto-detects build system (package.json / pyproject.toml / go.mod / Cargo.toml / Makefile) and pre-fills build/test/lint/run commands |
| `/spawn [--provider --model --name --tools] <task>` | Launch a single subagent with optional overrides. No implicit budget cap |
| `/director` | Promote session to Director mode at runtime (must be before any subagent spawns) |
| `/fleet status\|usage\|kill\|manifest\|retry\|log\|stream on\|off\|journal\|spawn\|terminate` | Inspect and control the subagent fleet. `log <id>` summarises; `log <id> raw` dumps full JSONL |
| `/agents` | Print fleet roster (running, idle, completed) with kind chips for failures |
| `/steer <text>` | Mid-flight redirect — aborts iteration, terminates fleet, drops queue, prepends STEERING preamble. Same as **Esc** then typing |
| `/goal <text>` | Lock in a goal — persists to `~/.wrongstack/projects/<hash>/goal.json` and injects full-autonomy preamble. Subcommands: `/goal` (status + journal), `/goal clear` (stop engine), `/goal pause` (pause at end of iteration), `/goal resume` (resume), `/goal journal [N]` |
| `/queue` | Show, clear, or delete entries from the in-flight message queue |
| `/altscreen on\|off` | Toggle terminal alt-screen buffer. Default OFF (native scroll); `on` for full-screen mode |
| `/plan show\|add\|start\|done\|remove\|clear` | Per-session plan JSON. Mirrored to disk; surfaces `📋 ⌛N ☐N ✓N` chip in TUI status bar |
| `/autonomy off\|suggest\|on\|eternal\|parallel\|stop\|toggle` | Self-driving mode. `suggest` shows next steps without executing; `on` auto-continues; `eternal` runs goal-driven loop; `parallel` fans out 4-8 subagents per tick. TUI shows `∞ AUTO` / `∞ SUGGEST` / `ETERNAL` / `⟳ PARALLEL` chip |
| `/yolo on\|off\|toggle` | Flip YOLO mode (auto-approve all tool calls). `/yolo` alone shows status. TUI shows `⚠ YOLO` chip |
| `/mode` | Switch persona: `default`, `code-reviewer`, `code-auditor`, `architect`, `debugger`, `tester`, `devops`, `refactorer`. Custom modes in `~/.wrongstack/modes/` |
| `/model` | Two-step provider → model picker |
| `/image` or `/paste-image` | Attach clipboard PNG. TUI also `Alt+V` |
| `/context mode <policy>` | Switch context-window mode: `balanced`, `frugal`, `deep`, `archival`. `repair` fixes damaged tool-call adjacency |
| `/plugin install\|disable\|enable\|remove\|official [name]` | Manage plugins. `install` adds bundled package to config (no npm). Restart to load/unload |
| `/telegram send\|read\|chat\|attach` | Telegram plugin: `send <chatId> <message>`, `read <chatId> [limit]`, `chat` list recent, `attach <file>` send file |
| `/sdd <path-to-spec.md>` | Spec-Driven Development workflow: `parse → analyze → generate → track → execute`. Built on `SpecParser`, `TaskTracker`, `TaskGenerator`, `TaskFlow` |
| `/use`, `/compact`, `/usage`, `/tools`, `/skill`, `/save`, `/resume`, `/help`, `/clear`, `/stats`, `/diag`, `/exit` | Switch modes, compact context, show usage, list tools/skills, save/resume session, help, clear, stats, diagnostics, exit REPL |

### Mid-flight controls

| Key / Command | What it does |
|---|---|
| **Esc** (while busy) | Soft interrupt — abort agent, terminate fleet, drop queue, set "steering pending". Next message carries a STEERING preamble |
| `/steer <text>` | Same as Esc + typing, in one shot. Works when Esc is eaten by tmux |
| `/goal <text>` | "No force stops this" — full autonomy contract. Only Esc / Ctrl+C interrupt |
| **Ctrl+C** × 1 | Cancel current iteration + terminate fleet (1.5s cap) |
| **Ctrl+C** × 2 | Force-exit Ink loop |
| **Ctrl+C** × 3 | Hard `process.exit(130)` |
| **Ctrl+F** | Toggle the graphical fleet monitor — per-subagent status + fleet-wide token gauge |
| `/fleet kill <id>` | Stop one specific subagent |

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

## Configuration

### Environment variables

| Variable | Description |
|----------|-------------|
| `<PROVIDER>_API_KEY` | API key for the provider (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) |
| `WRONGSTACK_FETCH_ALLOW_PRIVATE` | Set to `1` to allow localhost / private IPs in the `fetch` tool |
| `WRONGSTACK_BASH_ENV_PASSTHROUGH` | Set to `1` to disable the bash-tool env allowlist (legacy unsafe mode — see `SECURITY.md`) |

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

`apiKey`-like fields are auto-encrypted on first contact. Plaintext keys in older config files get migrated transparently on boot.

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

**2. Zero non-overridable behavior.** 16 services bound through `Container` (Logger, TokenCounter, SessionStore, MemoryStore, PermissionPolicy, Compactor, PathResolver, ConfigLoader, Renderer, InputReader, ErrorHandler, RetryPolicy, SkillLoader, SystemPromptBuilder, SecretScrubber, ModelsRegistry). 6 pipelines as middleware chains. Tools, providers, MCP servers, and slash commands all live in registries.

**3. Standalone sufficiency.** Works with 36 built-in tools, 4 wire-family transports, permission policy, and a curated system prompt — no plugins required.

**4. Layered, not monolithic.** `--no-features` flips off MCP, plugins, memory tools, models.dev fetch, and skill discovery. The minimal-viable WrongStack runs offline with no network calls at startup.

## Packages

| Package | Purpose |
|---------|---------|
| `@wrongstack/core` | Kernel, agent, types, registries, plugin contract |
| `@wrongstack/runtime` | Default runtime implementations, host composition helpers, extension pack contracts |
| `@wrongstack/providers` | Anthropic/OpenAI/OpenAI-compatible/Google wire adapters + SSE |
| `@wrongstack/tools` | 36 built-in tools (incl. SQLite codebase index) |
| `@wrongstack/mcp` | MCP server registry + reconnection logic |
| `@wrongstack/cli` | REPL, subcommands, slash commands, terminal renderer |
| `@wrongstack/tui` | Ink-based TUI (lazy-loaded behind `--tui`) |
| `@wrongstack/plug-lsp` | LSP plugin (`wrongstack-lsp-setup` binary) |
| `@wrongstack/telegram` | Telegram plugin: send/read/notifications, `/telegram:*` slash commands |
| `@wrongstack/webui` | Standalone web UI — `webui` binary, also via `wrongstack --webui` |
| `@wrongstack/plugins` | Official plugin collection — 10 plugins via subpath exports |

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

For the full walk-through — including the L1-A reactive `ConversationState`, how the six pipelines fire per turn, and how plugins / MCP / observability plug in — see [`docs/architecture.md`](docs/architecture.md).

## Status

- **4627 tests passing** across 335 test files (~20 s, 13 skipped)
- Coverage thresholds: ≥85 % lines / ≥85 % functions / ≥70 % branches / ≥82 % statements
- All workspace packages build clean with TypeScript strict + `noUncheckedIndexedAccess`
- Node 22+ only, ESM-only, no CommonJS bundles
- CI gate: `pnpm typecheck && pnpm build && pnpm test` all required
- Threat model: [`SECURITY.md`](SECURITY.md)

## Contributor docs

| Doc | What it covers |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Package layout, kernel primitives, agent lifecycle, L1-A reactive split |
| [`docs/slash/`](docs/slash/) | Full reference for every built-in slash command |
| [`docs/subcommands/`](docs/subcommands/) | Full reference for every `wstack <subcommand>` |
| [`docs/director-architecture.md`](docs/director-architecture.md) | Director: FleetBus, prompt layering, safety caps, per-subagent JSONL, shared scratchpad |
| [`docs/plugin-author-guide.md`](docs/plugin-author-guide.md) | Building a plugin: capabilities, dependencies, configSchema, teardown, testing |
| [`docs/plugin-management.md`](docs/plugin-management.md) | User-facing plugin workflows: list/add/remove/enable/disable, config layout |
| [`docs/provider-author-guide.md`](docs/provider-author-guide.md) | Adding an LLM provider via `WireFormatConfig`, stream-state design, vendor quirks |
| [`docs/tool-author-guide.md`](docs/tool-author-guide.md) | Writing a tool: streaming `executeStream`, permission semantics, `cleanup` vs `registerAbortHook` |
| [`docs/yolo-mode.md`](docs/yolo-mode.md) | YOLO mode: permission pipeline, runtime toggle, trust file, subagent policy |
| [`docs/skills.md`](docs/skills.md) | Writing skills: frontmatter format, discovery layers, description quality, token budget |
| [`docs/configuration.md`](docs/configuration.md) | Full config reference: every field with type, default, and example |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | Common issues, diagnosis steps, `wstack diag`, exit codes, reset commands |

## Benchmarks

`pnpm bench` runs all `*.bench.ts` files via a separate vitest config and writes results to `bench-results.json` (gitignored). Current suite covers compactor hot paths, token estimation, JSON-schema validation, and the system prompt builder. See [`vitest.bench.config.ts`](vitest.bench.config.ts).

## Examples

See [`examples/`](examples/) for 6 categories of working examples:

| # | Example | What it demonstrates |
|---|---------|----------------------|
| 01 | [Basic usage](examples/01-basic/) | Single-shot, REPL, session resume, YOLO |
| 02 | [Tool usage](examples/02-tools/) | File editing, code search, git, tests |
| 03 | [Multi-provider](examples/03-providers/) | Switching providers, custom endpoints |
| 04 | [MCP integration](examples/04-mcp/) | Connecting MCP servers, using MCP tools |
| 05 | [Multi-agent](examples/05-multi-agent/) | Director fleet, delegation, subagents |
| 06 | [Real-world workflows](examples/06-real-world/) | Refactoring, testing, debugging, audits |

## License

MIT © 2026 ECOSTACK TECHNOLOGY OÜ — see [LICENSE](LICENSE).