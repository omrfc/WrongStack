# WrongStack — IMPLEMENTATION

**Companion to:** `SPECIFICATION.md`
**Audience:** Implementers (humans and AI agents)
**Purpose:** File-by-file blueprint. For each module: purpose, exports,
dependencies, key types, edge cases, and test strategy.

---

## 0. Project Topology

```
wrongstack/
├── packages/
│   ├── core/                      @wrongstack/core
│   │   ├── src/
│   │   │   ├── kernel/
│   │   │   │   ├── container.ts
│   │   │   │   ├── pipeline.ts
│   │   │   │   ├── events.ts
│   │   │   │   └── tokens.ts
│   │   │   ├── core/
│   │   │   │   ├── agent.ts
│   │   │   │   ├── context.ts
│   │   │   │   └── system-prompt-builder.ts
│   │   │   ├── types/
│   │   │   │   ├── messages.ts
│   │   │   │   ├── blocks.ts
│   │   │   │   ├── tool.ts
│   │   │   │   ├── provider.ts
│   │   │   │   ├── plugin.ts
│   │   │   │   └── config.ts
│   │   │   ├── defaults/
│   │   │   │   ├── logger.ts
│   │   │   │   ├── session-store.ts
│   │   │   │   ├── memory-store.ts
│   │   │   │   ├── permission-policy.ts
│   │   │   │   ├── compactor.ts
│   │   │   │   ├── path-resolver.ts
│   │   │   │   ├── error-handler.ts
│   │   │   │   ├── retry-policy.ts
│   │   │   │   ├── skill-loader.ts
│   │   │   │   ├── secret-scrubber.ts
│   │   │   │   ├── token-counter.ts
│   │   │   │   └── config-loader.ts
│   │   │   ├── plugin/
│   │   │   │   ├── api.ts
│   │   │   │   └── loader.ts
│   │   │   ├── registry/
│   │   │   │   ├── tool-registry.ts
│   │   │   │   ├── provider-registry.ts
│   │   │   │   └── slash-command-registry.ts
│   │   │   ├── utils/
│   │   │   │   ├── diff.ts
│   │   │   │   ├── glob-match.ts
│   │   │   │   ├── safe-json.ts
│   │   │   │   ├── atomic-write.ts
│   │   │   │   └── newline-normalize.ts
│   │   │   └── index.ts
│   │   ├── tests/
│   │   └── package.json
│   │
│   ├── providers/                 @wrongstack/providers
│   │   ├── src/
│   │   │   ├── anthropic.ts
│   │   │   ├── openai.ts
│   │   │   ├── openai-compatible.ts
│   │   │   ├── presets.ts
│   │   │   ├── tool-format/
│   │   │   │   ├── to-anthropic.ts
│   │   │   │   ├── to-openai.ts
│   │   │   │   ├── from-anthropic.ts
│   │   │   │   └── from-openai.ts
│   │   │   ├── stop-reason.ts
│   │   │   └── index.ts
│   │   └── tests/
│   │
│   ├── tools/                     @wrongstack/tools
│   │   ├── src/
│   │   │   ├── read.ts
│   │   │   ├── write.ts
│   │   │   ├── edit.ts
│   │   │   ├── glob.ts
│   │   │   ├── grep.ts
│   │   │   ├── bash.ts
│   │   │   ├── fetch.ts
│   │   │   ├── todo.ts
│   │   │   ├── memory.ts          remember + forget
│   │   │   └── index.ts
│   │   └── tests/
│   │
│   ├── mcp/                       @wrongstack/mcp
│   │   ├── src/
│   │   │   ├── client.ts
│   │   │   ├── registry.ts
│   │   │   ├── wrap-tool.ts
│   │   │   └── index.ts
│   │   └── tests/
│   │
│   └── cli/                       @wrongstack/cli
│       ├── src/
│       │   ├── index.ts           bin entry
│       │   ├── repl.ts
│       │   ├── renderer.ts
│       │   ├── input-reader.ts
│       │   ├── slash-commands/
│       │   │   ├── help.ts
│       │   │   ├── clear.ts
│       │   │   ├── compact.ts
│       │   │   └── ... (one file per command)
│       │   ├── subcommands/
│       │   │   ├── init.ts
│       │   │   ├── resume.ts
│       │   │   ├── sessions.ts
│       │   │   ├── config.ts
│       │   │   ├── tools.ts
│       │   │   ├── skills.ts
│       │   │   ├── providers.ts
│       │   │   ├── mcp.ts
│       │   │   ├── plugin.ts
│       │   │   ├── diag.ts
│       │   │   ├── usage.ts
│       │   │   └── version.ts
│       │   ├── permission-prompt.ts
│       │   ├── diff-renderer.ts
│       │   └── theme.ts
│       └── tests/
│
├── apps/
│   └── wrongstack/                meta package (bin)
│       ├── src/index.ts
│       └── package.json
│
├── docs/                          docs site source
├── scripts/
│   ├── build-binary.ts           bun --compile
│   └── release.ts
├── SPECIFICATION.md
├── IMPLEMENTATION.md
├── TASKS.md
├── README.md
├── llms.txt
├── package.json                   pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── biome.json                     formatter + linter
```

### Workspace tooling

- **Package manager:** pnpm workspaces.
- **Build:** `tsup` for npm packages (ESM-only, no CJS in v1.0).
- **Test:** `vitest` (workspace mode).
- **Lint/format:** `biome` (replaces ESLint + Prettier).
- **Binary:** `bun build --compile` from `apps/wrongstack/src/index.ts`.
- **TS:** strict mode, `noUncheckedIndexedAccess: true`, target ES2023.
- **Node version:** ≥ 22 LTS.

---

## 1. Kernel Primitives (`packages/core/src/kernel/`)

### 1.1 `kernel/container.ts`

**Purpose:** Dependency injection container with explicit `bind`,
`override`, and `decorate` semantics.

**Exports:**
- `class Container`
- `type Token<T>`
- `type Factory<T>`

**Key invariants:**
- `bind()` is no-op-illegal: throws if already bound.
- `override()` is replace-only: throws if nothing to replace.
- `decorate()` stacks; order matches call order.
- Default `singleton: true`; cached value cleared on override or decorate.

**Edge cases:**
- Resolving an unbound token: throw with token description.
- Factory throws during resolve: propagate without caching the error.
- Self-referential factory (circular dependency): not detected in v1.0;
  documented in caveats. v1.1: optional cycle detector.

**Test strategy:**
- Unit tests for: bind, double-bind error, override, override-unbound
  error, decorate stacking order, singleton caching, child container
  scoping (if implemented).

**Approximate size:** ~80 lines + types.

### 1.2 `kernel/pipeline.ts`

**Purpose:** Koa-style middleware chain with named middleware and
position-aware insertion.

**Exports:**
- `class Pipeline<T>`
- `interface Middleware<T> { name: string; handler: ... }`

**Key methods:**
- `use(mw)`, `prepend(mw)`
- `insertBefore(name, mw)`, `insertAfter(name, mw)`
- `replace(name, mw)`, `remove(name)`
- `run(input): Promise<T>`
- `list(): readonly string[]`

**Invariants:**
- Middleware names unique within a pipeline; duplicate name throws.
- `next` may be called at most once per middleware.
- Calling `next` after returning is undefined behavior (throw in dev).

**Edge cases:**
- Empty pipeline: returns input unchanged.
- Middleware throws: propagates; subsequent middleware not invoked.
- `insertBefore` / `insertAfter` for unknown name: throws.

**Test strategy:**
- Unit: order preservation, modification primitives, exception
  propagation, async correctness.

**Approximate size:** ~50 lines + types.

### 1.3 `kernel/events.ts`

**Purpose:** Observe-only event bus. Subscribers cannot modify or cancel.

**Exports:**
- `class EventBus`
- `type EventMap` (extended via module augmentation by plugins)

**Methods:**
- `on<E>(event, fn)`, `off<E>(event, fn)`, `emit<E>(event, payload)`

**Invariants:**
- Subscriber exceptions are caught and logged via Logger; never
  propagate.
- Emission is synchronous; async subscribers run independently.

**Test strategy:**
- Unit: subscription, multiple subscribers, error isolation,
  unsubscribe.

**Approximate size:** ~30 lines.

### 1.4 `kernel/tokens.ts`

**Purpose:** Service token definitions (see Appendix A of SPEC).

**Exports:** `TOKENS` object with all 15 symbols typed via
`as Token<T>` for inference.

**Approximate size:** ~30 lines.

---

## 2. Core (`packages/core/src/core/`)

### 2.1 `core/agent.ts`

**Purpose:** The main agent loop (Section 3 of SPEC).

**Exports:**
- `class Agent`
- `interface RunResult`
- `MAX_ITERATIONS` constant (configurable; default 100)

**Public methods:**
- `run(input: string, opts: RunOptions): Promise<RunResult>`
- `register(t: Tool): void`
- `use(plugin: Plugin): Promise<void>`

**Dependencies (via Container):**
- Logger, RetryPolicy, ErrorHandler, Compactor, PathResolver,
  Renderer, SessionStore, MemoryStore, SkillLoader,
  SystemPromptBuilder, PermissionPolicy, SecretScrubber, TokenCounter.

**Edge cases:**
- AbortSignal between request preparation and provider call: bail
  immediately; partial state saved.
- Provider returns malformed content blocks: log and convert to
  text-only with error note; allow agent to recover.

**Test strategy:**
- Integration tests with a mock Provider that returns scripted
  responses; verify loop transitions, error recovery, signal handling.

**Approximate size:** ~250 lines.

### 2.2 `core/context.ts`

**Purpose:** Mutable per-session state container.

**Exports:**
- `class Context`
- `class TokenAccount`
- `interface RunOptions`

**Held state:**
- `messages: Message[]`
- `usage: TokenAccount`
- `todos: TodoItem[]`
- `readFiles: Set<string>` — for read-before-write invariant
- `session: SessionWriter` — current JSONL writer
- `systemPrompt: TextBlock[]`
- `provider: Provider`
- `signal: AbortSignal`

**Approximate size:** ~150 lines.

### 2.3 `core/system-prompt-builder.ts`

**Purpose:** Build 4-layer system prompt (Section 4 of SPEC).

**Exports:**
- `class DefaultSystemPromptBuilder implements SystemPromptBuilder`
- `LAYER_1_IDENTITY` constant (hardcoded text)
- `BuildContext` interface

**Behavior:**
- Layer 1: read from constant.
- Layer 2: iterate tools, concatenate `usageHint` (or generated default
  from description).
- Layer 3: gather env (cwd, OS, shell, node version, git status,
  detected languages); cached for session.
- Layer 4: read AGENTS.md, memory.md (project + global), skill manifest;
  append `cache_control` marker.

**Edge cases:**
- AGENTS.md > 8000 tokens: truncate with notice.
- Skill discovery fails: log, proceed with empty manifest.

**Test strategy:**
- Snapshot tests for each layer's output with a fixed input.
- Token budget assertion: ensures Layer 1+2+3 fits within 4000 tokens
  with default 8 tools.

**Approximate size:** ~300 lines.

---

## 3. Types (`packages/core/src/types/`)

Type-only files; no runtime code. Each file has a single concern.

- `messages.ts` — `Message`, `MessageRole`, `MessageContent`.
- `blocks.ts` — `ContentBlock`, `TextBlock`, `ToolUseBlock`,
  `ToolResultBlock`, `ImageBlock`.
- `tool.ts` — `Tool` interface, `ToolCallContext`.
- `provider.ts` — `Provider`, `Request`, `Response`, `Usage`,
  `Capabilities`, `StreamEvent`.
- `plugin.ts` — `Plugin`, `PluginAPI`.
- `config.ts` — `Config` and all sub-types.

**Approximate total size:** ~400 lines.

---

## 4. Default Implementations (`packages/core/src/defaults/`)

Each default is independent; replaceable via `Container.override`.

### 4.1 `defaults/logger.ts`

- Level-based filter (`error` < `warn` < `info` < `debug` < `trace`).
- Outputs to file (`.wrongstack/logs/wrongstack.log`) and stderr.
- `child(bindings)` returns a wrapped Logger that injects bindings.
- JSON line format on disk; pretty format on stderr.

### 4.2 `defaults/session-store.ts`

- JSONL append-only writer + reader.
- Session ID format: `<ISO>-<random4>`.
- `save(event)`, `load(id): Promise<Context>`.
- `list(limit): Promise<SessionSummary[]>`.
- Damaged session detection: orphan tool_use blocks → reject load.

### 4.3 `defaults/memory-store.ts`

- Read AGENTS.md, memory.md (project + global).
- Append with timestamp on `remember`.
- Substring match + confirm on `forget`.
- Consolidation when memory.md > 8000 tokens (sub-LLM call).

### 4.4 `defaults/permission-policy.ts`

- Load `trust.json`.
- Match command/path against glob patterns.
- Precedence: `deny` > `allow` > tool default.
- Interactive prompt for `confirm` cases (delegated to CLI Renderer).
- Persist "always allow" decisions back to `trust.json`.

### 4.5 `defaults/compactor.ts`

- Implements `HybridCompactor` (Section 9 of SPEC).
- Phase 1: elision of large tool_results outside the preserved K turns.
- Phase 2: summary via sub-LLM (default Haiku).
- Find-turn-boundary algorithm: nearest user-message-with-text at or
  after target index.

**Test strategy:**
- Synthetic conversations of varying sizes; verify token reduction,
  pair preservation invariant, todo state preservation.

### 4.6 `defaults/path-resolver.ts`

- Resolve symlinks; reject if outside project root.
- Normalize `..` traversal.
- Detect project root by walking up to find `.git`, `package.json`,
  `go.mod`, etc.

### 4.7 `defaults/error-handler.ts`

- Pattern-match error type → recovery decision.
- For retryable errors, defer to RetryPolicy.
- For unknown errors, return null (caller fails).

### 4.8 `defaults/retry-policy.ts`

- `shouldRetry(err, attempt)`, `delayMs(attempt)`.
- Exponential backoff + jitter; cap 30s.

### 4.9 `defaults/skill-loader.ts`

- Walk discovery paths in priority order.
- Parse frontmatter (YAML); validate `name` + `description`.
- Shadow by name when conflicts.
- `list()`, `find(name)`, `manifestText()`.

### 4.10 `defaults/secret-scrubber.ts`

- Regex set (see Section 16.3 of SPEC).
- `scrub(text: string): string` replaces matches with `[REDACTED:<type>]`.
- Used by tool result post-processing, logger, session writer.

### 4.11 `defaults/token-counter.ts`

- Wraps `Usage` accumulation.
- Cost estimate from pricing table (per-provider).

### 4.12 `defaults/config-loader.ts`

- Layer 1–6 merge (see Section 13 of SPEC).
- Schema validation via lightweight validator (custom or `@oxog/vld`).
- Returns frozen `Config` object.

**Approximate total for defaults:** ~1500 lines.

---

## 5. Plugin System (`packages/core/src/plugin/`)

### 5.1 `plugin/api.ts`

- `class PluginAPI` constructed from Agent and Container.
- Methods: `registerTool`, `registerProvider`, `registerSkill`,
  `registerMCPServer`, `on`, `config`, `log`.
- Each registration method records owner plugin for diagnostics.

### 5.2 `plugin/loader.ts`

- `loadPlugins(configs: PluginConfig[]): Promise<void>`
- Topological sort by `dependsOn`.
- `apiVersion` check against kernel's exported version.
- Per-plugin try/catch: failure isolated, others continue.
- Conflict check against `conflictsWith`.

**Approximate size:** ~250 lines.

---

## 6. Registries (`packages/core/src/registry/`)

### 6.1 `tool-registry.ts`

- `register(tool)`, `unregister(name)`, `replace(name, tool)`,
  `get(name)`, `list()`.
- Name uniqueness enforced; duplicate `register` is loud-fail.
- `replace` is explicit and logs WARN with previous owner.

### 6.2 `provider-registry.ts`

- `register(type, factory)`, `create(config)`.
- Factory pattern: `(config) => Provider`.

### 6.3 `slash-command-registry.ts`

- `register(cmd)`, `dispatch(line, ctx)`.
- Slash command names prefixed with `/`.

**Approximate total:** ~200 lines.

---

## 7. Utilities (`packages/core/src/utils/`)

- `diff.ts` — Myers diff implementation for unified diff output (~120
  lines). No external dependency.
- `glob-match.ts` — Minimal glob matcher for trust policy patterns
  (`*`, `**`, `?`, character classes); ~80 lines.
- `safe-json.ts` — JSON parse/stringify with error sanitization and
  size limits.
- `atomic-write.ts` — Temp file + fsync + rename pattern for safe
  writes.
- `newline-normalize.ts` — Detect file's newline style; normalize
  strings to match.

**Approximate total:** ~400 lines.

---

## 8. Providers (`packages/providers/src/`)

### 8.1 `anthropic.ts`

- Wraps `@anthropic-ai/sdk`.
- `complete()` is near pass-through; canonical format matches Anthropic.
- `stream()` defined but not implemented in v1.0.
- Capabilities: vision=true, parallelTools=true, promptCache=native.

### 8.2 `openai.ts`

- Wraps `openai` SDK.
- Conversion: `tool-format/to-openai.ts` + `from-openai.ts`.
- Strip `cache_control` markers on outbound.
- Split user messages with `tool_result` blocks into separate `tool`
  role messages.

### 8.3 `openai-compatible.ts`

- Extends `openai.ts` with `CompatibilityQuirks`.
- Constructor takes `baseUrl`, `headers`, `quirks`, `capabilities` override.

### 8.4 `presets.ts`

- Map of preset name → partial config (baseUrl, recommended quirks).
- Presets: groq, deepseek, moonshot, glm, ollama, openrouter,
  fireworks, together, xai, cerebras.

### 8.5 `tool-format/`

- `to-anthropic.ts`: `Tool[] → Anthropic.Tool[]` (trivial mapping).
- `from-anthropic.ts`: identity (canonical is Anthropic).
- `to-openai.ts`: handles the message restructuring and tool wrapping.
- `from-openai.ts`: parse `tool_calls`, sanitize arguments JSON,
  preserve IDs.

### 8.6 `stop-reason.ts`

- Normalize provider-specific stop reasons to canonical enum.

**Approximate total:** ~900 lines.

---

## 9. Tools (`packages/tools/src/`)

Each tool is a single file implementing the `Tool` interface.

### 9.1 `read.ts`

- Resolve path → sandbox check.
- Stat → size + type check.
- Binary detection: null byte in first 8 KB.
- Read with offset/limit using `readline` or `fs.readFile` + slice.
- Format with line numbers.

### 9.2 `edit.ts`

Most complex tool. Implements Section 6.2 of SPEC including:
- Path resolution and sandbox.
- Newline-style detection and normalization.
- Match counting with ambiguity reporting (line numbers of all matches).
- Stale-read detection via mtime + `ctx.readFiles` lookup.
- Atomic write via temp file.
- Unified diff generation for permission renderer.

**Edge case test matrix:**
- Empty `old_string` → error.
- `old_string === new_string` → no-op success.
- Mixed line endings in file vs `old_string` → normalize correctly.
- File modified externally → stale-read error.
- Unicode whitespace (NBSP, etc.) → exact match honored.
- Very large file (1 MB+) → still processed efficiently (streaming
  not required at this size).

### 9.3 `write.ts`

- Read-before-write invariant check.
- Diff rendering for permission (against existing or full new content).
- Atomic write.

### 9.4 `glob.ts`

- Wraps `fast-glob` (or in-house equivalent).
- Default ignore + `.gitignore` aware.
- Sort by mtime descending.

### 9.5 `grep.ts`

- Detect `rg` in PATH; prefer it.
- Fallback: in-process regex matcher walking matched files.
- Output mode handling (`content`, `files_with_matches`, `count`).

### 9.6 `bash.ts`

- `child_process.spawn('bash', ['-c', command])`.
- AbortSignal: `signal: opts.signal` plus explicit `child.kill()` on
  abort.
- Stream output, accumulate, truncate from middle if oversized.
- Strip ANSI escape codes.
- Background mode: spawn detached, return PID (v1.0 stores PID,
  companion `bash_output` tool deferred).

### 9.7 `fetch.ts`

- `node:fetch` with timeout via AbortSignal.
- Redirect handling.
- Content-Type-based body processing.
- HTML → markdown: minimal extractor (no external dep if feasible;
  otherwise lightweight library justified).
- SSRF protection via IP check before connect.

### 9.8 `todo.ts`

- Replaces `ctx.todos` entirely on each call.
- Renderer hook emits visible checkbox list to terminal.

### 9.9 `memory.ts`

- `remember(fact, scope)`: append to scope-appropriate file.
- `forget(query)`: find lines containing `query`, confirm, remove.
- Consolidation trigger when file size exceeds threshold.

**Approximate total:** ~1200 lines.

---

## 10. MCP (`packages/mcp/src/`)

### 10.1 `client.ts`

- Wraps `@modelcontextprotocol/sdk` client.
- Handles three transports: stdio, sse, streamable-http.
- Connection state machine: connecting → connected → disconnected
  → reconnecting → failed.

### 10.2 `registry.ts`

- `start(cfg)`, `stop(name)`, `restart(name)`, `list()`.
- Lifecycle: connect → initialize → list tools → wrap → register.
- Reconnect strategy: 3 attempts with exponential backoff.
- Emit `mcp.server.connected` / `mcp.server.disconnected` events.

### 10.3 `wrap-tool.ts`

- `wrapMCPTool(serverName, mcpTool, client): Tool`.
- Namespace: `mcp__<server>__<tool>`.
- Permission: from server config default (`confirm`).
- Mutation heuristic: name contains `create|update|delete|write|send`.
- Output stringification: handle text, image, embedded resource
  responses uniformly.

**Approximate total:** ~400 lines.

---

## 11. CLI (`packages/cli/src/`)

### 11.1 `index.ts` (bin entry)

- Parse argv (use `citty` or in-house minimal parser).
- Resolve subcommand or default to REPL.
- Initialize Agent (boot config, plugins, providers, MCP servers).
- Wire up SIGINT to AbortController.
- Exit codes: 0 success, 1 generic error, 2 config error, 130 SIGINT.

### 11.2 `repl.ts`

- `readline` interface with multi-line support.
- History persistence.
- Tab completion (slash commands, paths).
- Ctrl+C handling (double-press to exit).
- Slash command dispatch (intercepts user input).

### 11.3 `renderer.ts`

- Implements `Renderer` service.
- Markdown rendering in terminal (use `marked` + custom terminal
  renderer, or in-house).
- Code block syntax highlighting (use `cli-highlight` or similar;
  one allowed dependency).
- Tool call announcements: name + key input field.
- Tool result rendering: respect truncation.
- Diff rendering: colored unified diff (red/green).

### 11.4 `input-reader.ts`

- Handles user input, including multimodal paste detection
  (image-from-clipboard for terminals that support it).
- Slash command detection (input starts with `/`).

### 11.5 `slash-commands/`

One file per command. Each exports a `SlashCommand` object. Registered
in `index.ts` boot.

### 11.6 `subcommands/`

One file per subcommand. Each exports a function
`(args, agent, ctx) => Promise<number>` (exit code).

### 11.7 `permission-prompt.ts`

- Interactive prompt with single-keystroke shortcuts.
- Displays diff for `edit`/`write`.
- "Always allow X" persistence to `trust.json`.

### 11.8 `diff-renderer.ts`

- Uses `core/utils/diff.ts` for diff computation.
- Adds color and context formatting.

### 11.9 `theme.ts`

- Colors per Section 3 of Branding (amber primary, jarring pink
  accent, near-black background).
- Detects terminal capabilities; falls back to monochrome.

**Approximate total:** ~1500 lines.

---

## 12. Meta Package (`apps/wrongstack/`)

- `src/index.ts`: just re-exports `@wrongstack/cli`'s bin.
- `package.json`: declares the `bin` field as `wrongstack` and `wstack`.
- This is what users install: `npm install -g wrongstack`.

---

## 13. Tests

### 13.1 Test pyramid

```
Unit tests             ~70%  (kernel, defaults, utils, individual tools)
Integration tests      ~25%  (agent loop with mock provider,
                              MCP server lifecycle, plugin loading)
End-to-end tests       ~5%   (CLI invocations against a fake project)
```

### 13.2 Coverage target

- Kernel: 100% line + branch coverage.
- Defaults: 95%+.
- Tools: 100% for edit (highest-risk), 90%+ for others.
- Providers: 90%+ with mocked HTTP.
- CLI: 80%+ (interactive parts harder to test).

### 13.3 Test infrastructure

- `vitest` workspace config.
- `MockProvider` test helper: scripted responses, abort simulation,
  retry simulation.
- `MockMCPServer`: in-process stdio MCP server for integration tests.
- `tmp-project` helper: creates temp directory with sample files,
  cleaned after test.

---

## 14. Documentation

### 14.1 `README.md`

Audience: humans + LLMs (scrape-friendly).
Order:
1. TL;DR (3 lines + install + 1 example)
2. Why WrongStack (60 seconds)
3. Quick start (5 minutes)
4. Provider configuration
5. Extending (plugins, tools, providers)
6. Comparison table (vs Aider, Cursor, Claude Code)
7. License + contact

### 14.2 `llms.txt`

LLM-optimized reference under 2000 tokens. Lives at repo root and at
`wrongstack.com/llms.txt`. Contains: package name, install, minimal
config example, core API surface, 5 most common scenarios.

### 14.3 `docs/`

- Architecture deep dives (Container, Pipeline, EventBus).
- Plugin authoring guide.
- Provider authoring guide.
- MCP integration guide.
- Skill writing guide.

---

## 15. CI/CD

### 15.1 GitHub Actions workflows

- `ci.yml`: on every PR — lint, typecheck, unit + integration tests
  on Node 22 (Linux + macOS + Windows).
- `release.yml`: on tag — builds binary for 5 targets, publishes npm
  packages, creates GitHub Release.
- `docs.yml`: deploys docs site on push to main.

### 15.2 Versioning

- Independent versioning per package, but in practice released
  together via `changesets`.
- `wrongstackApiVersion` field in `@wrongstack/core/package.json`
  drives plugin compat checks.

---

## 16. Dependencies — Allowed and Justified

WrongStack is not zero-dependency, but every runtime dependency must
be justified.

| Package | Purpose | Justification |
|---|---|---|
| `@anthropic-ai/sdk` | Anthropic API client | Mandatory; SSE handling and types |
| `openai` | OpenAI API client | Convention for community + Azure variants |
| `@modelcontextprotocol/sdk` | MCP protocol | 1500+ lines saved; official |
| `fast-glob` | Glob matching | Battle-tested; can be replaced if in-house glob proves sufficient |

**Disallowed for v1.0:**
- ESLint / Prettier (use biome)
- Lodash (use stdlib)
- Axios (use native fetch)
- Jest (use vitest)
- Webpack/Rollup (use tsup)
- Inquirer (build minimal prompt in-house)
- Chalk (use small color helper; one file)

**Approximate dependency footprint:** 4 direct runtime deps. Acceptable
within "minimal but practical" philosophy.

---

## 17. Performance Targets

- Cold boot (no plugins): < 200 ms to interactive prompt.
- With 5 plugins + 2 MCP servers: < 500 ms.
- Tool registration (per tool): < 1 ms.
- Container resolve (singleton hit): < 10 μs.
- Pipeline run (5 middleware, no IO): < 100 μs.
- Compaction (50K tokens → 30K tokens): < 3 seconds (dominated by
  sub-LLM call).

---

## 18. Security Posture

- All paths sanitized via `PathResolver` before tool execution.
- All tool outputs scrubbed for secrets before context inclusion.
- All MCP tool calls default `confirm`.
- All bash commands default `confirm` unless trust-allowlisted.
- No `eval`, no dynamic `Function`, no `require` in plugin loading
  (use `import()` with explicit paths).
- Session files have user-only permissions (0600).
- Logs scrubbed of secrets before write.
- HTTPS enforced for `fetch` by default; opt-out per-domain.

---

## 19. Implementation Order (high level)

Detailed task sequence is in `TASKS.md`. The high-level order is:

1. Workspace + tooling setup.
2. Kernel primitives + tokens.
3. Types.
4. Default services (lowest priority first: logger, path resolver,
   atomic-write utility).
5. Agent loop + Context + SystemPromptBuilder.
6. AnthropicProvider (gets the loop working end-to-end first).
7. Built-in tools (one at a time, edit last because complexity).
8. CLI layer (basic REPL first, subcommands incrementally).
9. SessionStore + resume.
10. Compactor.
11. MemoryStore + remember/forget.
12. SkillLoader.
13. PermissionPolicy + trust.json.
14. OpenAI + OpenAI-compatible providers.
15. MCP integration.
16. Plugin loader.
17. Subcommands (init, diag, plugin, etc.).
18. Polish, docs, binary build.
19. Release.

---

**END OF IMPLEMENTATION**
