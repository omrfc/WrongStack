# WrongStack — SPECIFICATION

**Version:** 1.0.0-draft
**Tagline:** *Built on the wrong stack. Shipped anyway.*
**License:** Apache-2.0
**Maintainer:** ECOSTACK TECHNOLOGY OÜ

---

## 0. About This Document

This is the authoritative specification for WrongStack v1.0. It defines
*what* the system does, *how* its modules contract with each other, and
*which* invariants are non-negotiable. Implementation details that follow
naturally from this specification live in `IMPLEMENTATION.md`. Sequenced
work items live in `TASKS.md`.

When this document and any other source disagree, this document wins.

---

## 1. Philosophy & Goals

WrongStack rests on three contracts. Every design decision is arbitrated
against them. If a decision conflicts with a contract, the decision is
wrong.

**Contract 1 — Minimal kernel.** The kernel (`src/kernel/` +
`src/core/`) must not exceed 600 lines. The kernel contains Container,
Pipeline, EventBus, the Agent loop, and Context. Everything else is a
replaceable default implementation.

**Contract 2 — Zero non-overridable behavior.** No core behavior is
hardcoded. All 15 services are bound through Container and can be
overridden. All 8 pipelines are middleware chains and can be extended,
modified, or replaced. Tools, providers, skills, MCP servers, and slash
commands all live in registries and can be added or removed at runtime.

**Contract 3 — Standalone sufficiency.** A senior developer must be able
to use WrongStack productively with zero plugins installed. Built-in
capability (8 tools + 3 providers + 1 default skill pack + permission
policy + system prompt) is sufficient for daily coding work. The plugin
ecosystem is for growth, not for fixing gaps.

### Anti-goals

WrongStack v1.0 explicitly does **not** aim to be:

- A TUI (it ships a CLI with a minimal REPL).
- An IDE plugin (can be wrapped but is not the core scenario).
- A framework (it is an opinionated but self-contained CLI).
- An autonomous agent (every destructive action requires permission
  unless explicitly allowlisted in trust policy).
- A multi-agent orchestrator (sub-agents are a plugin domain).

### Target user

A developer who treats the terminal as their primary workspace, owns the
quality of their code, and uses AI as an assistant rather than a leader.
Vibe coders are not the target audience.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  CLI Layer                                          │
│    • Entry / REPL / single-shot dispatch            │
│    • Renderer (output formatter)                    │
│    • InputReader (readline, slash commands)         │
│    • Subcommand router                              │
├─────────────────────────────────────────────────────┤
│  Agent Layer                                        │
│    • Agent loop (iteration controller)              │
│    • Context (messages, todo, usage)                │
│    • Permission policy                              │
│    • Token accounting + Compactor                   │
│    • Session store + Memory store                   │
│    • Skill loader + System prompt builder           │
├─────────────────────────────────────────────────────┤
│  Kernel — the 3 primitives                          │
│    • Container (DI, service replacement)            │
│    • Pipelines (data flow middleware)               │
│    • EventBus (observe-only notifications)          │
│    • Registries (Tool, Provider, MCP, SlashCommand) │
├─────────────────────────────────────────────────────┤
│  Provider Layer                                     │
│    • Provider interface (canonical wire format)     │
│    • AnthropicProvider / OpenAIProvider / OAICompat │
│    • Retry + rate-limit policy                      │
│    • Streaming event normalization                  │
└─────────────────────────────────────────────────────┘
```

**Data flow direction:** CLI → Agent → Kernel/Provider → Agent → CLI.
State lives in the Agent layer only. The Kernel is stateless. The
Provider layer is stateless.

**Canonical internal representation:** Anthropic-style content blocks
(`text`, `tool_use`, `tool_result`, `image`). All services communicate
in this format; provider adapters perform translation at the edges.

### Three kernel primitives

1. **Container** — answers: *"Which implementation is bound to service
   X?"* Used for state-holding or singleton-like services (Logger,
   SessionStore, Compactor, etc.).
2. **Pipeline** — answers: *"How does data flow through operation X?"*
   Middleware chains for request shaping, response handling, tool
   execution, etc.
3. **EventBus** — answers: *"Who is notified when X happens?"*
   Observe-only; subscribers cannot modify or cancel.

If a customization need does not fit any of these three categories, the
need is either a Registry concern (tools, providers, MCP servers) or
the abstraction is incorrect.

### Override depth (4 layers + 1)

```
Layer 0 — Default              Works out of the box.
Layer 1 — Configure            Tune knobs (config file, env, CLI flags).
Layer 2 — Add middleware       Insert into existing pipeline.
Layer 3 — Decorate service     Wrap an existing service.
Layer 4 — Replace service      Swap implementation entirely.
Layer 5 — Full plugin          Compose all of the above as a package.
```

---

## 3. The Agent Loop

### 3.1 Lifecycle

```typescript
async function run(
  userInput: string,
  ctx: Context,
  signal: AbortSignal
): Promise<RunResult> {
  ctx.session.append({ type: 'user_input', content: userInput });
  ctx.messages.push({ role: 'user', content: userInput });

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    signal.throwIfAborted();
    events.emit('iteration.started', { ctx, index: i });

    // 1. Request pipeline
    const req: Request = await pipelines.request.run({
      model: cfg.model,
      system: ctx.systemPrompt,
      messages: ctx.messages,
      tools: registries.tools.list(),
      maxTokens: cfg.maxTokens,
    });

    // 2. LLM call (with retry policy, abort-safe)
    let res: Response;
    try {
      res = await provider.complete(req, { signal });
    } catch (err) {
      if (signal.aborted) throw err;
      const recovered = await errorHandler.recover(err, ctx);
      if (!recovered) return { status: 'failed', error: err };
      res = recovered;
    }

    // 3. Response pipeline
    res = await pipelines.response.run(res);
    ctx.usage.add(res.usage);
    ctx.messages.push({ role: 'assistant', content: res.content });
    ctx.session.append({ type: 'llm_response', ...res });

    // 4. Render assistant text blocks
    for (const block of res.content) {
      if (block.type === 'text') {
        const rendered = await pipelines.assistantOutput.run(block);
        renderer.write(rendered);
      }
    }

    // 5. Tool use extraction
    const toolUses = res.content.filter(b => b.type === 'tool_use');
    if (toolUses.length === 0) {
      events.emit('iteration.completed', { ctx, index: i });
      return { status: 'done', usage: ctx.usage };
    }

    // 6. Execute tools
    const toolResults = await executeTools(toolUses, ctx, signal);
    ctx.messages.push({ role: 'user', content: toolResults });

    events.emit('iteration.completed', { ctx, index: i });
  }

  return { status: 'max_iterations', usage: ctx.usage };
}
```

### 3.2 Tool execution strategy

```typescript
type ExecutionStrategy = 'parallel' | 'sequential' | 'smart';
```

- `parallel`: All tools in one turn execute concurrently.
- `sequential`: One after another in order received.
- `smart` (default): Non-mutating tools (`mutating: false`) parallel;
  mutating tools sequentially after them; final order matches input.

### 3.3 AbortSignal propagation

Three signal sources, combined via `AbortSignal.any()`:

1. User SIGINT (Ctrl+C) at CLI layer.
2. Iteration timeout (default 300s).
3. Total session timeout (default 1800s).

Every `Provider.complete()` and `Tool.execute()` must accept and respect
the signal. Built-in tools terminate cleanly: `bash` sends SIGTERM,
`fetch` aborts the HTTP request, file tools clean up temp files.

### 3.4 Error recovery taxonomy

| Class | Behavior |
|---|---|
| Provider 429 (rate limit) | RetryPolicy: 5 attempts, exponential backoff with jitter |
| Provider 529 (overloaded) | 3 attempts, 10s/30s/60s |
| Provider 5xx | 3 attempts |
| Provider 4xx (validation, auth) | Fail fast; user error message |
| Network/timeout | 2 attempts |
| Malformed tool_use input | Tool returns `tool_result` with error; LLM corrects |
| Unknown tool | `tool_result` with error + tool list; LLM corrects |
| Tool throws | Stringify error → `tool_result`; LLM retries or pivots |
| Context overflow | Trigger compaction pipeline; re-attempt |
| AbortSignal | Propagate; partial state saved to session |

---

## 4. System Prompt Design

The system prompt is WrongStack's character. It is structured in 4
layers, the last of which carries the `cache_control` marker for
prompt caching.

### 4.1 Layer 1 — Identity & Principles (static, hardcoded)

```
You are WrongStack, a command-line AI coding agent.

You operate inside the user's terminal with direct read and write
access to their working directory, the ability to run shell commands,
and access to the web. You assist a developer who knows what they're
doing — your job is to accelerate them, not to second-guess them.

## Core principles

1. Read before you write. Always inspect the relevant files before
   proposing changes. Assumptions about code you haven't read are
   bugs in waiting.

2. Prefer surgical edits over rewrites. When modifying existing
   files, use the `edit` tool with str_replace; only use `write` for
   new files or full replacements explicitly requested.

3. Show your work. Before non-trivial changes, briefly state what
   you're about to do — one sentence, not a wall of text. After tool
   calls, summarize what happened, not what you did mechanically.

4. Honest about limits. If you don't know, say so. If something
   failed, say what failed and what you'll try next. Never fabricate
   file contents, API responses, or test results.

5. Concise output. The user is a developer in a terminal. No
   marketing language, no "great question!", no bullet-point lists
   when prose works. If a one-liner answers, a one-liner is the
   answer.

6. Ask when blocked, proceed when not. If the task is ambiguous in
   a way that meaningfully changes the approach, ask. If it's
   ambiguous in a way that doesn't, pick a reasonable default and
   proceed, stating the assumption.

7. Trust the tools. If a permission prompt is shown, the user will
   answer. Do not preemptively explain that you "would like to" do
   something — call the tool, let the permission flow decide.

## What you do not do

- You do not lecture about software engineering principles unless
  asked.
- You do not add comments to code unless they materially help or
  were requested.
- You do not refactor adjacent code while fixing a bug, unless
  asked.
- You do not claim work is "production-ready" or "fully tested" —
  the user decides that.
- You do not apologize for failures. You report them and proceed.
```

### 4.2 Layer 2 — Tool Usage Guidelines (semi-static)

`SystemPromptBuilder` generates a paragraph per registered tool from
the tool's `usageHint` field. Built-in tools ship with curated hints
(see Section 6 for each).

### 4.3 Layer 3 — Environment Context (session-static)

```
## Environment

- Working directory: <path>
- Project root (git): <path or "not a git repo">
- Operating system: <platform> <version>
- Shell: <name>
- Node.js: <version>
- Detected languages: <primary>, <secondary>, ...
- Git status: branch=<name>, <N> modified, <N> staged
- Today's date: <ISO date>
```

### 4.4 Layer 4 — Project Memory & Skills (cached, mutable)

Concatenated content of `AGENTS.md` (project), `memory.md` (persistent
notes), and the skills manifest (name + description + path for each
discovered skill). Skill bodies are **not** included; the agent reads
SKILL.md on demand via the `read` tool.

The `cache_control: { type: 'ephemeral' }` marker is placed at the end
of Layer 4. Cache invalidates when memory is written or skills change;
re-caches automatically.

### 4.5 Token budget

```
Layer 1 (identity)              ~  800 tokens (fixed)
Layer 2 (tool usage, built-in)  ~ 1200 tokens
Layer 3 (environment)           ~  200 tokens
Layer 4 (memory + skills)         500–3000 tokens
                                ─────────────────
TOTAL                             2700–5200 tokens
```

If plugins add tools, Layer 2 grows by ~150 tokens per tool. The
builder offers an "essential mode" config flag to compress descriptions
when total budget would exceed 8000 tokens.

---

## 5. Providers

### 5.1 Provider interface

```typescript
interface Provider {
  readonly id: string;
  readonly capabilities: Capabilities;

  complete(req: Request, opts: { signal: AbortSignal }): Promise<Response>;
  stream?(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent>;
}

interface Request {
  model: string;
  system?: TextBlock[];
  messages: Message[];
  tools?: Tool[];
  maxTokens: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  toolChoice?: 'auto' | 'required' | 'none' | { type: 'tool'; name: string };
}

interface Response {
  content: ContentBlock[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal';
  usage: Usage;
  model: string;
}

interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface Capabilities {
  tools: boolean;
  parallelTools: boolean;
  vision: boolean;
  streaming: boolean;
  promptCache: boolean;
  systemPrompt: boolean;
  jsonMode: boolean;
  reasoning: boolean;
  maxContext: number;
  cacheControl: 'native' | 'auto' | 'none';
}
```

### 5.2 Streaming event schema (canonical)

```typescript
type StreamEvent =
  | { type: 'message_start'; model: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_input_delta'; id: string; partial: string }
  | { type: 'tool_use_stop'; id: string; input: unknown }
  | { type: 'message_stop'; stopReason: string; usage: Usage };
```

Streaming is **contracted in v1.0 but implemented in v1.1**. v1.0 uses
blocking `complete()` only. The contract is defined now so the Renderer
service is built around event consumption from day one.

### 5.3 Built-in providers

**AnthropicProvider** (`id: 'anthropic'`)
- Native cache control support
- All capabilities true except `jsonMode`
- 200K max context
- Tool format pass-through (canonical is Anthropic-shaped)

**OpenAIProvider** (`id: 'openai'`)
- Vision (model-dependent)
- No native cache control (implicit prefix caching only)
- 128K max context (conservative default)
- Tool format conversion: canonical blocks → `tool_calls` arrays;
  `tool_result` blocks → separate `tool` role messages
- `cache_control` markers stripped before send

**OpenAICompatibleProvider** (`id: <preset> | 'openai-compatible'`)
- Generic adapter for OpenAI-spec endpoints
- Accepts `baseUrl`, `headers`, and `CompatibilityQuirks`
- Preset profiles: `groq`, `deepseek`, `moonshot`, `glm`, `ollama`,
  `openrouter`, `fireworks`, `together`, `xai`, `cerebras`
- Quirks profile fields:
  - `stripCacheControl` (default true)
  - `systemAsMessage`
  - `flattenContentToString`
  - `preserveToolCallIds` (default true)
  - `parallelToolsDisabled`
  - `jsonArgumentsBuggy` (sanitize JSON in `tool_calls`)
  - `emptyToolCallContent` (`'null' | 'empty_string'`)

### 5.4 Retry policy

```typescript
interface RetryPolicy {
  shouldRetry(err: ProviderError, attempt: number): boolean;
  delayMs(attempt: number): number;
}
```

Default implementation uses exponential backoff with jitter and caps
at 30s. Replaceable via `container.override(TOKENS.RetryPolicy, ...)`.

### 5.5 Tool format conversion (the hardest edge)

The OpenAI conversion has three subtle pitfalls:

1. `tool_use.input` (object) ↔ `tool_calls.function.arguments` (JSON
   string). Buggy JSON from some compatible providers requires
   sanitization on the inbound side.
2. A canonical user message containing multiple `tool_result` blocks
   becomes N separate `tool` role messages.
3. Tool IDs must be preserved across the round-trip. Some providers
   rewrite IDs; the adapter uses the response IDs for matching.

---

## 6. The 8 Built-in Tools

### Common interface

```typescript
interface Tool<I = unknown, O = unknown> {
  name: string;
  description: string;        // visible to LLM
  usageHint?: string;         // injected into system prompt (Layer 2)
  inputSchema: JSONSchema7;
  permission: 'auto' | 'confirm' | 'deny';
  mutating: boolean;          // for parallel execution scheduling
  maxOutputBytes?: number;    // default 32_768
  timeoutMs?: number;         // default 10_000
  execute(input: I, ctx: Context, opts: { signal: AbortSignal }): Promise<O>;
}
```

### 6.1 `read`

- **Permission:** `auto`
- **Mutating:** false
- **maxOutputBytes:** 262_144 (256 KB)
- **timeoutMs:** 5_000
- **Input:** `{ path: string, offset?: int, limit?: int }`
- **Output:** line-numbered content + metadata (`total_lines`,
  `encoding`, `truncated`)
- **Errors:** file not found (suggest near matches via glob),
  sandbox violation, binary file, > 5 MB.

### 6.2 `edit` (DEEP SPEC)

- **Permission:** `confirm` (always; trust policy can bypass)
- **Mutating:** true
- **timeoutMs:** 5_000
- **Input:**
  ```typescript
  {
    path: string;
    old_string: string;     // exact match incl. whitespace
    new_string: string;     // may be empty for deletion
    replace_all?: boolean;  // default false
  }
  ```

**Behavior:**

1. Path resolve + sandbox check.
2. Reject if file does not exist (suggest `write`).
3. Reject if binary.
4. Read full content.
5. Newline normalization: detect file's newline style; normalize
   `old_string` and `new_string` to file's style.
6. Match counting:
   - 0 matches → error with similarity hint (line of nearest substring)
   - 2+ matches & `replace_all=false` → error listing all match line
     numbers; require more context
   - 2+ matches & `replace_all=true` → proceed
   - 1 match → proceed
7. No-op detection: `old_string === new_string` → warn, success.
8. Stale-read detection: if file mtime newer than the in-session
   `lastRead` timestamp, error: "File modified externally. Re-read
   first."
9. Atomic write: temp file in same directory → fsync → rename.
10. Return: `{ path, replacements, diff }` (unified diff for renderer).

**Rejected alternative — multi-edit array argument:** A `edits[]`
parameter (taking multiple replacements in one call) was considered
and rejected. Reasons: schema complexity increases LLM error rate;
permission UX cannot atomically show multi-change diffs cleanly;
atomicity guarantees become unclear (partial success). Single edit
per call, multiple calls for multiple changes.

**Read-before-write invariant:** A `write` or `edit` on an existing
file requires the agent to have called `read` on that file in the
current session. Tracked via `ctx.readFiles: Set<string>`. Plugins
may disable this with `allowBlindWrite: true`.

### 6.3 `write`

- **Permission:** `confirm`
- **Mutating:** true
- **Input:** `{ path: string, content: string }`
- **Behavior:** see read-before-write invariant in 6.2. Atomic write.
  Returns `{ path, bytes_written, created }`.

### 6.4 `glob`

- **Permission:** `auto`
- **Mutating:** false
- **maxOutputBytes:** 65_536
- **Input:** `{ pattern: string, path?: string, limit?: int }`
- **Behavior:** glob library (single justified dependency: `fast-glob`
  or in-house). Default ignore: `node_modules`, `.git`, `dist`,
  `build`, `.next`. `.gitignore` aware. Results sorted by mtime
  descending.

### 6.5 `grep`

- **Permission:** `auto`
- **Mutating:** false
- **maxOutputBytes:** 131_072
- **Input:**
  ```typescript
  {
    pattern: string;             // PCRE2 regex
    path?: string;
    glob?: string;               // file filter
    output_mode?: 'content' | 'files_with_matches' | 'count';
    context_lines?: int;
    case_insensitive?: boolean;
    limit?: int;
  }
  ```
- **Behavior:** prefer `ripgrep` via shell-out (fast, reliable);
  fallback to in-process Node implementation if `rg` unavailable.

### 6.6 `bash`

- **Permission:** `confirm` (trust policy can bypass per-command)
- **Mutating:** true (conservative)
- **timeoutMs:** 30_000
- **maxOutputBytes:** 32_768
- **Input:** `{ command: string, timeout_ms?: int, background?: bool }`
- **Behavior:**
  - Run via `bash -c` (fallback `sh -c`).
  - Cwd = project root.
  - Env = inherited + `WRONGSTACK_SESSION_ID`.
  - stdout + stderr merged.
  - Output sanitization: ANSI strip, CR normalize, truncate from
    middle if oversized (preserve head + tail).
  - Background mode: spawn detached, return PID. Companion tool
    `bash_output(pid)` for polling — **v1.1**.

### 6.7 `fetch`

- **Permission:** `confirm`
- **Mutating:** false
- **timeoutMs:** 20_000
- **maxOutputBytes:** 131_072
- **Input:** `{ url: string, format?: 'markdown' | 'text' | 'raw' }`
- **Behavior:**
  - HTTPS only by default (HTTP rejected unless allowlisted).
  - User-Agent: `WrongStack/1.0 (+https://wrongstack.com)`.
  - Max 5 redirects.
  - Content-Type handling:
    - `text/html` → readability + markdown extraction
    - `application/json` → pretty-printed
    - `text/*` → raw
    - Binary → reject
  - SSRF protection: block localhost and RFC1918 by default; opt-in
    via env flag for local dev.

### 6.8 `todo`

- **Permission:** `auto`
- **Mutating:** false (agent state, no filesystem touch)
- **Input:** `{ todos: TodoItem[] }` where each item is
  `{ id, content, status: 'pending' | 'in_progress' | 'completed' }`.
- **Invariant:** at most one `in_progress` task at a time. System
  prompt enforces this.

### 6.9 `remember` and `forget` (memory tools, see Section 10)

Two additional tools shipped in core; not strictly "primary 8" but
required for the standalone memory feature.

---

## 7. Skills System

### 7.1 Layout

```
.wrongstack/skills/<name>/
  SKILL.md              # required, frontmatter + content
  references/           # optional
  scripts/              # optional
```

SKILL.md frontmatter:

```yaml
---
name: typescript-strict
description: |
  Use this skill when writing or reviewing TypeScript code with strict
  mode. Covers strict null checks, exhaustive switch, branded types,
  discriminated unions.
version: 1.0.0
---
```

### 7.2 Discovery order (shadowing)

```
.wrongstack/skills/             # project (highest priority)
~/.wrongstack/skills/           # user
<bundled>/skills/               # ship-with-binary
```

Same `name` in a higher layer shadows lower layers.

### 7.3 Activation (progressive disclosure)

At boot, only the manifest (name + description + path) is injected
into Layer 4. SKILL.md content is read on demand by the agent via the
`read` tool. References and scripts are read in further calls as
needed.

### 7.4 Default skills shipped

- `typescript-strict`
- `node-modern`
- `react-modern`
- `git-flow`
- `prompt-engineering`

No more than five default skills. Beyond this, users curate their own.

---

## 8. MCP Integration

### 8.1 Architecture position

`src/mcp/` is a sub-system independent of the kernel. From the agent's
view, MCP tools appear as normal Tools; internally they route through
`MCPClient` instances managed by `MCPRegistry`.

### 8.2 Server config

```typescript
interface MCPServerConfig {
  name: string;
  transport: 'stdio' | 'sse' | 'streamable-http';

  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;

  // remote
  url?: string;
  headers?: Record<string, string>;

  // common
  enabled?: boolean;             // default true
  allowedTools?: string[];       // whitelist; undefined = all
  permission?: 'auto' | 'confirm' | 'deny';  // default 'confirm'
  startupTimeoutMs?: number;     // default 10_000
}
```

### 8.3 Namespace convention

All MCP tools are registered as `mcp__<server>__<tool>`. This prevents
collision both between MCP servers and with built-in tools.

### 8.4 Lifecycle

- Boot: connect → initialize → list tools → wrap and register.
- Runtime: tool calls proxy to the MCP client.
- Connection drop: 3 reconnect attempts with exponential backoff; on
  final failure, server marked disabled, its tools unregistered, agent
  continues with warning.
- Shutdown: graceful `client.close()` for all servers.

### 8.5 Permission default

All MCP tools default to `confirm` regardless of declared read-only
status. Trust policy can allowlist by namespace (e.g.
`mcp__postgres__*: { auto: true }`).

### 8.6 Scope for v1.0

- Tools only. Resources and Prompts are deferred to v1.1.

---

## 9. Context Management

### 9.1 Token accounting

Token counts come from real `Response.usage` returned by the provider.
Local estimation libraries (tiktoken, etc.) are not used in v1.0 for
accounting; only for pre-flight estimation if needed.

### 9.2 Thresholds

```
context.warnThreshold      = 0.6   # inline UI warning
context.softThreshold      = 0.75  # trigger compaction
context.hardThreshold      = 0.9   # aggressive compaction
```

### 9.3 Compactor (Hybrid: Elision + Summary)

```typescript
interface Compactor {
  compact(ctx: Context, opts?: { aggressive?: boolean }): Promise<CompactReport>;
}
```

**Phase 1 — Elision:**
- For tool_result blocks older than the recent K turns (default
  K = 10), if the result's serialized size exceeds `eliseThreshold`
  (default 500 tokens), replace its content with:
  ```
  [elided: <tool_name>(<input_summary>), ~<N> tokens removed.
   Call again if needed.]
  ```
- The block remains in place; only the content is shortened.
  Tool_use/tool_result pairing is preserved.

**Phase 2 — Summary:**
- If after Phase 1 the estimated context is still above target (60%
  of max), invoke a sub-LLM call (default `claude-haiku-4-5`) to
  summarize older turns.
- The cut boundary is the nearest user message (working backward
  from `length - 2K`) that contains actual text — never a
  tool-result-only message. This ensures no orphan tool_use blocks
  remain.
- Replace cut turns with a synthetic
  `[user: <previous_session_summary>...]` + `[assistant:
  "Continuing from compacted context."]` pair.
- Extract and preserve current todo state in the summary.

**Invariants:**
- Every `tool_use` block always has its matching `tool_result` block.
- Recent K turns are never compacted.
- todo state survives compaction.
- Cache markers invalidate; one cold turn, then cache resumes.

### 9.4 Manual control

Slash commands: `/compact`, `/compact aggressive`, `/clear`, `/usage`.

---

## 10. Memory

### 10.1 Three files, three scopes

```
.wrongstack/AGENTS.md       project memory (committed to git)
.wrongstack/memory.md       agent-written notes (gitignored)
~/.wrongstack/memory.md     user-global personal memory
```

All three are read at boot and injected into Layer 4. Combined size
limit: 8000 tokens. Over-limit triggers consolidation.

### 10.2 Tools

**`remember`** — append a fact with timestamp to scope-appropriate
file. Permission: auto. System prompt instructs the agent to use
sparingly (transient state belongs in todo).

**`forget`** — remove a previously remembered fact (substring match,
confirm prompt). Permission: confirm.

### 10.3 Consolidation

When memory.md exceeds 8000 tokens, a sub-LLM call deduplicates and
groups entries. The previous version is saved as
`memory.md.bak.<timestamp>` before overwrite.

---

## 11. Session & Logging

### 11.1 Session log (JSONL append-only)

```
.wrongstack/sessions/<ISO-timestamp>-<random>.jsonl
```

Event types: `session_start`, `user_input`, `llm_request`,
`llm_response`, `tool_use`, `tool_result`, `compaction`, `error`,
`session_end`. Every event timestamped (ISO 8601 UTC).

### 11.2 Resume

```
wstack resume [<session-id>]
```

`SessionStore.load(id)` replays events to reconstruct messages and
context state. Damaged sessions (orphan tool_use blocks) are rejected
with a specific error.

### 11.3 Logging layers

- **Session log** → JSONL in `sessions/` (always, regardless of
  log level).
- **Operational log** → `.wrongstack/logs/wrongstack.log` (level
  configurable, default `info`).
- **Stderr** → `warn+` always; `info` with `--verbose`; `trace`
  with `--trace`.

Sensitive scrubbing applies to all layers (see Section 16.3).

---

## 12. Permission Model

### 12.1 Levels

```typescript
type Permission = 'auto' | 'confirm' | 'deny';
```

### 12.2 Trust policy file

`.wrongstack/trust.json` (gitignored, project-local).

```json
{
  "bash": {
    "allow": ["git status", "git diff*", "npm test", "npm run *"],
    "deny":  ["rm -rf *", "sudo *", "curl * | sh"]
  },
  "write": {
    "allow": ["src/**", "tests/**", "docs/**"],
    "deny":  ["**/.env*", "**/secrets/**", "**/.git/**"]
  },
  "edit": { "trustWorkdir": true, "deny": ["**/.env*"] },
  "fetch": {
    "allow": ["https://docs.anthropic.com/**"],
    "denyPrivate": true
  },
  "mcp__github__*": { "auto": true }
}
```

Patterns are glob style. Match precedence: `deny` > `allow` >
default permission.

### 12.3 Confirm prompt

Single-keystroke UX:

```
edit  src/auth.ts
─────────────────
<unified diff, ~10 lines>

[y]es  [n]o  [a]lways allow edits to src/**  [d]eny  [v]iew full diff
```

"Always allow" persists to `trust.json`.

### 12.4 Deny is absolute

Plugins that decorate `PermissionPolicy` cannot bypass `deny` rules.
This is a hard invariant.

### 12.5 --yolo flag

`wstack --yolo` skips all confirm prompts but still honors `deny`
rules. Intended for sandboxed environments.

---

## 13. Configuration

### 13.1 Layered loading

```
1. Built-in defaults                                       (lowest)
2. ~/.wrongstack/config.{ts,json,yaml}                     user-global
3. <project-root>/.wrongstack/config.{ts,json,yaml}        project
4. <project-root>/.wrongstack/config.local.{...}           gitignored local
5. Environment variables (WRONGSTACK_*)
6. CLI flags                                                (highest)
```

Deep merge: objects merged, arrays replaced.

### 13.2 Schema

```typescript
interface Config {
  version: 1;
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  providers?: Record<string, ProviderConfig>;
  context: ContextConfig;
  tools: ToolsConfig;
  mcpServers?: Record<string, MCPServerConfig>;
  plugins?: (string | PluginConfig)[];
  services?: ServiceOverrides;
  pipelines?: PipelineMods;
  log: LogConfig;
}
```

Boot-time validation is strict. Validation failure is loud: specific
path + reason, no fallback to partial config.

### 13.3 Environment variable mapping

```
WRONGSTACK_PROVIDER       → provider
WRONGSTACK_MODEL          → model
WRONGSTACK_API_KEY        → apiKey
WRONGSTACK_LOG_LEVEL      → log.level
ANTHROPIC_API_KEY         → providers.anthropic.apiKey
OPENAI_API_KEY            → providers.openai.apiKey
```

### 13.4 CLI flags (selective)

```
--provider <name>     override provider
--model <name>        override model
--cwd <path>          override working directory
--log-level <level>
--yolo                skip confirm prompts (deny still enforced)
--verbose, -v         log.level = debug
--trace               log.level = trace
--config <path>       custom config file
```

---

## 14. CLI Commands

### 14.1 Subcommands

```
wstack                          REPL
wstack "<task>"                 single-shot
wstack resume [<session-id>]    resume session
wstack sessions                 list recent sessions
wstack init                     scaffold .wrongstack/ in project
wstack config show              effective config dump
wstack config edit              $EDITOR
wstack tools                    registered tools + overrides
wstack skills                   discovered skills
wstack providers                configured providers + status
wstack mcp list                 MCP servers + connection state
wstack mcp restart <name>       reconnect single server
wstack plugin list              loaded plugins
wstack plugin install <pkg>     npm install + config update
wstack plugin remove <name>
wstack plugin disable <name>
wstack diag                     full diagnostics
wstack usage [--since=today]    token + cost summary
wstack version                  version + apiVersion + commit
wstack help [<subcommand>]
```

### 14.2 Slash commands (in REPL)

```
/help
/clear              new session
/compact [aggressive]
/save [<id>]
/load <id>
/use <provider>     switch provider mid-session
/model <name>       switch model
/tools              current registered tools
/skill <name>       show skill manifest
/cost               session usage + estimate
/exit, /quit, /q    graceful exit
```

Plugin slash commands use `/<plugin>:<command>` namespace.

### 14.3 REPL UX

- Multi-line input: `\` continuation, or `"""..."""` block
- History: `~/.wrongstack/history` (readline-compatible)
- Ctrl+C: cancel current iteration; second Ctrl+C exits
- Ctrl+D: graceful exit
- Tab completion: subcommands, slash commands, paths

---

## 15. Plugin System

### 15.1 Plugin contract

```typescript
interface Plugin {
  name: string;
  version?: string;
  apiVersion: string;          // SemVer range, e.g. "^1.0"
  dependsOn?: string[];
  conflictsWith?: string[];
  setup(api: PluginAPI): void | Promise<void>;
  teardown?(api: PluginAPI): void | Promise<void>;
}

interface PluginAPI {
  container: Container;
  pipelines: typeof PIPELINES;
  events: EventBus;
  tools: ToolRegistry;
  providers: ProviderRegistry;
  mcp: MCPRegistry;
  config: AgentConfig;
  log: Logger;
}
```

### 15.2 Loading

- Plugins listed in `config.plugins` are loaded in the listed order.
- `dependsOn` is topologically sorted; cycles are loud-fail.
- `conflictsWith` violations are loud-fail.
- `apiVersion` is checked against kernel's exported `apiVersion`;
  incompatibility skips the plugin with an error log; other plugins
  proceed.

### 15.3 Override semantics

- `Container.bind()`: error if already bound.
- `Container.override()`: replaces existing binding; logs WARN with
  previous and new owner.
- `Container.decorate()`: stacks; order determined by plugin load
  order.
- `pipeline.use()` / `prepend()` / `insertBefore()` / `insertAfter()`
  / `replace()` / `remove()`: explicit ordering primitives. Duplicate
  middleware names within a pipeline are loud-fail.

### 15.4 Diagnostics

`wstack diag` prints:
- Kernel version + apiVersion
- All container bindings with current owner
- All pipelines with middleware list
- All registered tools, providers, MCP servers, slash commands
- All loaded plugins with their declared modifications

This is the first stop for "why is this behaving strangely?"

---

## 16. Resource Limits & Safety

### 16.1 Global token budget (optional)

```typescript
context: {
  maxSessionTokens?: number;
  maxDailyTokens?: number;
}
```

Default: no cap. Cost-based caps are a plugin concern
(`@wrongstack/plug-cost-cap`).

### 16.2 Per-tool limits

| Tool   | Timeout | maxOutputBytes |
|--------|---------|----------------|
| read   | 5s      | 256 KB         |
| write  | 5s      | —              |
| edit   | 5s      | —              |
| glob   | 5s      | 64 KB          |
| grep   | 10s     | 128 KB         |
| bash   | 30s     | 32 KB          |
| fetch  | 20s     | 128 KB         |
| todo   | 1s      | —              |

**Per-iteration cumulative tool output cap:** 100 KB. Excess ends
iteration early with a warning log.

### 16.3 Secrets scrubbing

`SecretScrubber` default patterns include (non-exhaustive):
- Anthropic key: `sk-ant-api03-[A-Za-z0-9_-]+`
- OpenAI key: `sk-proj-[A-Za-z0-9_-]+`
- GitHub PAT: `ghp_[A-Za-z0-9]{36}`, `github_pat_[A-Za-z0-9_]+`
- AWS access key: `AKIA[0-9A-Z]{16}`
- AWS secret: matched by entropy heuristic
- Private keys: `-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----`
- JWT: `eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`
- DB URIs: `mongodb(\+srv)?://`, `postgres://`, `mysql://`
- Slack tokens, Stripe keys, Twilio keys
- `.env`-style assignments with high-entropy values

Matches are replaced with `[REDACTED:<type>]` across tool results,
log files, session JSONL, and renderer output.

### 16.4 Workdir sandbox

`PathResolver`:
- Resolves symlinks; rejects if resolved target is outside project
  root.
- Normalizes `..` traversal; rejects if normalized path is outside.
- Absolute paths are checked against project root prefix.

Exception: `bash` may execute outside the sandbox (shell semantics
complicate constraint enforcement). This is acknowledged trust;
`bash` has its own confirm flow.

---

## 17. Distribution & Packaging

### 17.1 NPM workspace

```
@wrongstack/core         kernel + agent + default impls
@wrongstack/cli          CLI layer + renderer + REPL
@wrongstack/providers    built-in 3 providers
@wrongstack/tools        built-in 8 tools
wrongstack               meta package + bin
```

### 17.2 Single binary

`bun build --compile` produces platform-specific binaries:

```
wrongstack-linux-x64
wrongstack-linux-arm64
wrongstack-darwin-x64
wrongstack-darwin-arm64
wrongstack-win-x64.exe
```

Published as GitHub Release artifacts on each tagged version.
~50–60 MB compressed.

### 17.3 Install paths

```
npm install -g wrongstack
bun install -g wrongstack
curl -fsSL https://wrongstack.com/install.sh | sh
```

### 17.4 First-run

If no config is found at startup, a five-prompt interactive setup
writes `~/.wrongstack/config.json` with provider, API key, model.

### 17.5 Self-update

Not in v1.0. `wstack self-update` planned for v1.1.

---

## 18. Open Questions / Deferred

Items explicitly **not** in v1.0:

| Item | Notes |
|---|---|
| Streaming implementation | Contract defined v1.0; impl v1.1 |
| Sub-agent / spawn tool | Plugin domain |
| MCP Resources & Prompts | v1.1 |
| Self-update mechanism | v1.1 |
| Web UI / TUI renderer | Plugin (renderer is replaceable) |
| Sandbox containerization | Plugin |
| Auto-test integration | Plugin |
| Cost budget enforcement | Plugin |
| Conversation export | v1.1 |
| Telemetry (opt-in) | v1.1 plugin |
| Persistent OAuth flows | Plugin |
| Distributed sessions | Far future |

The principle: if a feature can be powerfully expressed as a plugin
without core changes, it does not enter the core.

---

## Appendix A — Service Tokens

```typescript
export const TOKENS = {
  Logger:               Symbol('Logger')              as Token<Logger>,
  TokenCounter:         Symbol('TokenCounter')        as Token<TokenCounter>,
  SessionStore:         Symbol('SessionStore')        as Token<SessionStore>,
  MemoryStore:          Symbol('MemoryStore')         as Token<MemoryStore>,
  PermissionPolicy:     Symbol('PermissionPolicy')    as Token<PermissionPolicy>,
  Compactor:            Symbol('Compactor')           as Token<Compactor>,
  PathResolver:         Symbol('PathResolver')        as Token<PathResolver>,
  ConfigLoader:         Symbol('ConfigLoader')        as Token<ConfigLoader>,
  Renderer:             Symbol('Renderer')            as Token<Renderer>,
  InputReader:          Symbol('InputReader')         as Token<InputReader>,
  ErrorHandler:         Symbol('ErrorHandler')        as Token<ErrorHandler>,
  RetryPolicy:          Symbol('RetryPolicy')         as Token<RetryPolicy>,
  SkillLoader:          Symbol('SkillLoader')         as Token<SkillLoader>,
  SystemPromptBuilder:  Symbol('SystemPromptBuilder') as Token<SystemPromptBuilder>,
  SecretScrubber:       Symbol('SecretScrubber')      as Token<SecretScrubber>,
};
```

## Appendix B — Named Pipelines

```typescript
export const PIPELINES = {
  request:          new Pipeline<Request>(),
  response:         new Pipeline<Response>(),
  toolCall:         new Pipeline<ToolCallContext>(),
  userInput:        new Pipeline<UserInputContext>(),
  assistantOutput:  new Pipeline<TextBlock>(),
  contextWindow:    new Pipeline<Context>(),
  sessionLoad:      new Pipeline<SessionData>(),
  sessionSave:      new Pipeline<SessionData>(),
};
```

## Appendix C — Event Types

```typescript
type EventMap = {
  'session.started':       { id: string };
  'session.ended':         { id: string; usage: Usage };
  'iteration.started':     { ctx: Context; index: number };
  'iteration.completed':   { ctx: Context; index: number };
  'tool.executed':         { name: string; durationMs: number; ok: boolean };
  'token.threshold':       { used: number; limit: number };
  'compaction.fired':      { before: number; after: number };
  'mcp.server.connected':  { name: string; toolCount: number };
  'mcp.server.disconnected': { name: string; reason: string };
  'error':                 { err: Error; phase: string };
};
```

---

**END OF SPECIFICATION**
