# Lifecycle Hooks

Hooks let third-party code (plugins, skills, operator-authored scripts) **observe
and steer** the agent at well-defined lifecycle points — block a tool call,
rewrite its arguments, inject context, or run side effects.

Unlike the `EventBus` (which is observe-only and cannot change what happens),
hooks are **interceptors**: a hook can short-circuit an action, mutate its
inputs, or append context that the model sees. This is the system that lets an
operator say "if X happens, you step in" — without recompiling the host.

## Two execution models

| Model | Who registers | Transport | Use case |
|---|---|---|---|
| **Shell hooks** | Operator, via `config.hooks` | Subprocess: `HookInput` JSON → stdin, `HookOutcome` JSON → stdout | Glue scripts, lint/format/notify pipelines, anything you'd rather write in bash/python than ship as a plugin |
| **In-process hooks** | Plugins, via `api.registerHook` | Direct function call | Type-safe, low-latency, needs access to host internals (registries, stores) |

Both models share the **same** payload (`HookInput`) and **same** outcome
contract (`HookOutcome`), and both are driven by a single `HookRunner` per
session. The runner reads from one shared `HookRegistry`, so a tool call can be
shaped by a mix of shell and in-process hooks in the same turn.

Disable **everything** for a session with `--no-hooks`. Shell hooks are also
independently gated by the runner's `allowShell` flag (set false under
`--bare` and in untrusted sessions).

---

## Events

These are the lifecycle points a hook can attach to:

| Event | When it fires | Can block? | Can mutate / inject |
|---|---|---|---|
| `PreToolUse` | Before a tool runs, **before** the permission check | ✅ (tool never runs) | rewrite tool input via `modifiedInput` |
| `PostToolUse` | After a tool returns | — | append `additionalContext` to the result |
| `UserPromptSubmit` | Before a user turn is processed | ✅ (turn ends, no model call) | append `additionalContext` to the user message |
| `SessionStart` | Once, on the first turn of the session | — | append `additionalContext` to the system prompt (persists for the session) |
| `Stop` | At the end of every turn | — | side effects only |

### Trigger ordering within an event

All hooks for a given event fire in **registration order**. There are three
distinct fire patterns, one per category of outcome:

1. **Blockable chain** (`PreToolUse`, `UserPromptSubmit`) — hooks run
   **sequentially**, in the order they were registered. The first hook that
   returns `decision: "block"` short-circuits the chain: no later hook for
   that event runs, and the block decision is returned to the caller. If no
   hook blocks, all hooks in the chain complete.

2. **Mutation chain** (`PreToolUse` only, `modifiedInput`) — within the
   sequential chain, each hook sees the **output of the previous hook** as its
   `toolInput`. Mutations compose left-to-right. The final composed input is
   re-validated against the tool's JSON Schema before the tool runs.

3. **Fan-out collection** (`PostToolUse`, `SessionStart`, `Stop`) — hooks run
   in **parallel** (`Promise.allSettled`) because none mutate state or block.
   Each hook independently returns `additionalContext`; the runner joins all
   returned contexts with `\n` and passes the concatenation back to the caller.
   Order in the joined string is **not** guaranteed (parallel resolution).

Registration order for **in-process** hooks is the order `api.registerHook` was
called during `setup()`. Registration order for **shell** hooks is the order
they appear in the per-event array under `config.hooks`. When both exist for an
event, in-process and shell entries interleave by insertion time — the loader
walks the shared `entries` array in array order.

### PreToolUse runs before the permission policy

This is deliberate: a hook can veto a tool that the trust file would otherwise
auto-allow, and a hook can rewrite arguments so a borderline call lands safely
inside what the trust file already permits. The permission policy runs **only**
on the post-hook (possibly rewritten) input.

---

## Registration

### Shell hooks (operator, via config)

Declared under `config.hooks`, a `Partial<Record<HookEvent, ShellHook[]>>`.
Loaded once at boot by `HookRegistry.loadShellHooks(config.hooks)`.

```jsonc
// config.json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "bash", "command": "./scripts/guard-bash.sh", "timeoutMs": 3000 },
      { "matcher": "edit|write", "command": "./scripts/audit-edit.sh" }
    ],
    "SessionStart": [
      { "command": "./scripts/on-start.sh" }
    ],
    "Stop": [
      { "command": "./scripts/on-stop.sh" }
    ]
  }
}
```

Shell hooks are owned by the **runtime** (no plugin name), so they survive
plugin install/uninstall cycles. They are reloaded only at boot — runtime config
changes do not hot-reload hooks for the current session.

### In-process hooks (plugins)

Registered through `PluginAPI.registerHook`. Returns an unsubscribe function;
the host also records the registration under the plugin's name so it can be
bulk-removed on teardown.

```ts
import type { PluginAPI } from '@wrongstack/core';

export default {
  name: 'lint-after-edit',
  capabilities: { hooks: true },          // declare intent (see Capability gating)
  setup(api: PluginAPI) {
    const off = api.registerHook('PostToolUse', 'edit|write', async (input) => {
      const lint = await runLint(input.toolInput);
      return lint ? { additionalContext: `Lint:\n${lint}` } : {};
    });
    // `off` is called automatically when the plugin is uninstalled.
    // You usually don't need to call it yourself.
  },
};
```

A plugin may register **multiple** hooks against the same or different events;
each call returns its own unsubscribe function. All of them are removed together
when the plugin's API is drained (see [Plugin / skill loading &
unloading](#plugin--skill-loading--unloading)).

---

## Payload (`HookInput`)

Identical for both transports. Flat and JSON-serializable so shell and in-process
hooks see the same shape.

```jsonc
{
  "event": "PreToolUse",
  "toolName": "bash",                                   // PreToolUse / PostToolUse
  "toolInput": { "command": "ls" },                     // PreToolUse / PostToolUse
  "toolResult": { "content": "...", "isError": false }, // PostToolUse only
  "prompt": "user text",                                // UserPromptSubmit only
  "cwd": "/abs/project",
  "sessionId": "01J..."                                 // when known
}
```

The types intentionally avoid referencing the live `Context` (which lives in a
higher layer) so `types/config.ts` can import them without a layering cycle. The
runtime pieces (`HookRegistry`, `HookRunner`, `runShellHook`) translate live run
state into this serializable shape at each phase.

---

## Outcome (`HookOutcome`)

A shell hook may **print** a JSON object to stdout; an in-process hook may
**return** one. Every field is optional — an empty object, `undefined`, or a
shell hook that prints nothing all mean "allow, no side effect".

```jsonc
{
  "decision": "block",                     // "block" | "allow" (omit = allow)
  "reason": "blocked: rm -rf",             // shown to the model on block
  "modifiedInput": { "command": "ls -la" },// PreToolUse only
  "additionalContext": "note for the model"// see per-event semantics above
}
```

**Shell shortcut:** exit code `2` forces `decision: "block"` (with stderr, or
failing that stdout, truncated to 2 000 chars as the reason), matching Claude's
convention. Any other exit code with no JSON on stdout is a no-op.

`modifiedInput` is **only honored for `PreToolUse`**. The executor swaps it in
and **re-validates** it against the tool's `inputSchema` before running — a hook
cannot bypass the schema. A re-validation failure is fed back to the model as
an error so it can self-correct.

---

## Filters / preconditions (matchers)

`PreToolUse` and `PostToolUse` entries take a `matcher`. All other events ignore
it (every registered hook for that event runs).

A matcher is one of:

- `"*"` (or empty/omitted) — matches every tool
- A **pipe-delimited, case-insensitive** list of exact tool names, e.g. `"bash"`,
  `"edit|write"`, `"bash|edit|write"`

Matching is by **exact tool name**, not substring or regex. `"edit"` matches the
tool named `edit`; it does **not** match `editFile`. The comparison is
case-insensitive on both sides, so `"Bash"` matches a tool registered as `bash`.

For non-tool events (`UserPromptSubmit`, `SessionStart`, `Stop`) the matcher is
treated as `*` and every registered hook runs. There is no content-based filter
on `prompt` or `additionalContext` — if you need one, write it inside your hook.

---

## Async behavior

- **In-process hooks** may be sync or async. The runner always `await`s the
  return value, so a `Promise<HookOutcome>` is fine. Long-running work should
  still respect the session's iteration timeout — a hook that never resolves
  will block the agent loop.
- **Shell hooks** are spawned and awaited with a per-invocation timeout
  (`timeoutMs`, default 5 000 ms). On timeout the child is sent `SIGKILL` and
  the hook resolves to a no-op (`null`).
- The runner uses `Promise.allSettled` for fan-out events so a single slow hook
  does not block its siblings — but the caller still awaits every hook before
  continuing, so the slowest hook in a fan-out sets the floor for that phase.
- Hooks share the agent's event loop. They cannot be cancelled mid-flight by
  the user pressing Ctrl-C; the abort signal propagates to tool execution but
  not into hook bodies. Keep hooks short.

---

## Error isolation

**A hook can never crash the agent.** Every hook invocation is wrapped in a
try/catch inside `HookRunner.invoke`:

| Failure mode | Resolution | Surfaced as |
|---|---|---|
| In-process hook throws | Caught, logged at `warn`, treated as no-op (`null`) | `logger.warn("<event> hook threw: <msg>")` |
| In-process hook returns a non-object | Coerced to `null` (no-op) | nothing |
| Shell hook fails to spawn | Caught, logged, `null` | `logger.warn("hook spawn failed: ...")` |
| Shell hook times out | Child killed, `null` | `logger.warn("hook command timed out after <ms>ms: <cmd>")` |
| Shell hook exits non-zero (≠ 2) with no JSON | Parsed as `null` | nothing |
| Shell hook emits invalid JSON | Parse error swallowed, `null` | nothing |
| Shell hook emits valid JSON missing fields | Missing fields dropped, partial outcome used | nothing |

The isolation guarantee is **per-hook**: one hook failing does not prevent
other hooks in the same chain/fan-out from running, and does not abort the
tool call, user turn, or session.

The only exception is an **explicit `decision: "block"`**, which is the hook
doing its job, not a failure. A block propagates normally (tool not run / turn
ended) and the `reason` is shown to the model.

### Output caps

- Shell hook stdout is capped at **64 KiB**. Beyond that the buffer is
  truncated and the hook's outcome (if any) is parsed from the truncated
  prefix.
- Shell hook stderr is capped at 64 KiB for the block-reason fallback.
- Block reasons are truncated to **2 000 chars** before being shown to the
  model.

---

## Security model

- Shell hooks run arbitrary commands **you** put in your own config — they are
  not model-controlled and cannot be installed by a prompt. Still: keep hook
  scripts in version control and review them like any other automation.
- `runShellHook` enforces a **command allowlist** (shells, interpreters, common
  utilities, git). Commands not on the list are rejected and logged. The two
  documented escape hatches for operator-authored executables are:
  1. Reference a script by **absolute path** (POSIX `/...` or Windows
     `C:\...`/`C:/...`) — trusted because you wrote it.
  2. Drop a wrapper under `.wrongstack/hooks/` and reference it by absolute
     path.
- `--no-hooks` disables **both** shell and in-process hooks for the session.
  Shell hooks are additionally gated by the runner's `allowShell` flag.
- Shell hooks inherit a sanitized child environment via `buildChildEnv()`.
- Hooks never receive secrets in their payload. The payload contains tool
  names, inputs, results, cwd, and sessionId — never API keys or tokens.

---

## Plugin / skill loading & unloading

### Loading

1. **Boot phase.** `HookRegistry.loadShellHooks(config.hooks)` registers every
   shell hook from config. These are owned by the runtime.
2. **Plugin setup phase.** The plugin loader topologically sorts plugins by
   `dependsOn`/`optionalDeps`, then calls each plugin's `setup(api)`. Inside
   `setup`, a plugin calls `api.registerHook(...)`. Each call:
   - Adds an `inprocess` entry to the shared `HookRegistry`, tagged with the
     plugin's name as `owner`.
   - Pushes the returned unsubscribe function onto the plugin's private
     `pluginCleanupFns` stack.
3. **Capability gate.** If a plugin declares `capabilities` and includes
   `hooks: false`, the loader wraps its API so `registerHook` emits a warning
   (default) or throws (when `enforceCapabilities: true`). A plugin that
   declares `hooks: true` (or declares no capabilities at all) is not gated.
   See [Capability gating](#capability-gating-for-hooks) below.

### Unloading

Plugin teardown happens in **reverse registration order** (mirroring stack-style
resource ownership when plugin B depends on plugin A):

1. The loader calls `plugin.teardown(api, { signal })` with a per-plugin timeout
   (default 10 000 ms).
2. `DefaultPluginAPI.drainCleanup()` runs every function on `pluginCleanupFns`
   — including each hook's unsubscribe — best-effort (errors swallowed).
3. **Belt-and-braces backstop:** `drainCleanup()` then calls
   `HookRegistry.drainByOwner(pluginName)`, which removes any in-process hook
   still tagged with that plugin's name. This catches the edge case where
   `setup()` threw **partway through** after registering some hooks — the
   per-call unsubscribes for the not-yet-pushed hooks would otherwise never
   fire, leaving dangling closures in the registry.
4. Shell hooks (runtime-owned) are **never** removed by `drainByOwner`. They
   persist for the session and are cleared by `HookRegistry.clear()` only at
   full session teardown.

The result: **no plugin-owned hook can outlive its plugin.** Even a plugin that
crashes during setup leaves a clean registry.

### Hot reload

Hooks are **not** hot-reloaded. `config.hooks` is read once at boot; runtime
changes to config (via `/config` or programmatic update) do not re-run
`loadShellHooks` for the current session. Restart the session to pick up new
shell hooks. In-process hooks follow plugin lifecycle: installing a plugin via
the plugin manager runs its `setup` (registering its hooks); uninstalling runs
its `teardown` (draining them).

---

## Capability gating for hooks

`PluginCapabilities` includes an optional `hooks` flag, mirroring the existing
gates for `tools`, `providers`, `slashCommands`, and `mcp`:

```ts
export interface PluginCapabilities {
  tools?: boolean;
  providers?: boolean;
  pipelines?: string[];
  slashCommands?: boolean;
  mcp?: boolean;
  toolMutateCapabilities?: string[];
  hooks?: boolean;   // ← will the plugin call api.registerHook()?
}
```

The loader applies the gate **only when `capabilities` is non-null** (this
matches the existing tools/providers behavior — capability gating is opt-in).
Inside the gate:

| Declaration | Behavior on `registerHook` |
|---|---|
| `hooks: true` | Pass-through, no warning |
| `hooks: false` | Warning logged (default) **or** `PluginError` thrown (`enforceCapabilities: true`); call still forwarded |
| `capabilities` omitted entirely | No wrap applied — pass-through (consistent with tools/providers) |

Use `enforceCapabilities: true` in CI / strict deployments to force plugins to
declare every subsystem they touch.

---

## DI & internals

- **Types:** `packages/core/src/types/hooks.ts` — `HookEvent`, `HookInput`,
  `HookOutcome`, `InProcessHook`, `ShellHook`, `HookEntry`.
- **Registry:** `packages/core/src/hooks/registry.ts` — `HookRegistry` with
  `registerInProcess`, `registerShell`, `loadShellHooks`, `list`, `has`,
  `all`, `drainByOwner`, `countByOwner`, `clear`; plus the exported
  `hookMatcherMatches(matcher, toolName)` predicate.
- **Runner:** `packages/core/src/hooks/runner.ts` — `HookRunner` with
  `preToolUse`, `postToolUse`, `userPromptSubmit`, `sessionStart`, `stop`, and
  the cheap `has(event)` guard.
- **Shell executor:** `packages/core/src/hooks/shell-executor.ts` —
  `runShellHook(spec, input, logger?)` with allowlist, timeout, and output cap.
- **DI token:** `TOKENS.HookRegistry` (`packages/core/src/kernel/tokens.ts`).
  Resolve it from the container to get the session's shared registry.
- **Plugin API surface:** `PluginAPI.registerHook` (`plugin/api.ts`) and the
  `hookRegistry` field on `PluginAPIInit`.
- **Consumer wiring:**
  - `PreToolUse` / `PostToolUse` are called from `ToolExecutor.executeBatch`
    (`execution/tool-executor.ts`), gated behind `hookRunner.has(event)` so the
    payload is only built when something listens.
  - `UserPromptSubmit` is a `userInput` pipeline middleware
    (`packages/cli/src/hooks-wiring.ts` → `createUserPromptSubmitMiddleware`).
    A `block` outcome throws `HookBlockedError`, which the pipeline's error
    boundary rethrows so `Agent.run` ends the turn without a model call.
  - `SessionStart` and `Stop` are an `AgentExtension`
    (`createLifecycleHooksExtension`). `SessionStart` fires on the first
    `beforeRun` and appends its `additionalContext` to `ctx.systemPrompt` for
    the rest of the session. `Stop` fires on every `afterRun`.
- **Boot wiring:** `packages/cli/src/cli-main.ts` calls
  `hookRegistry.loadShellHooks(config.hooks)` when hooks are enabled, and
  installs the middleware + extension into the agent.

### Public exports

From `@wrongstack/core`:

```ts
import {
  HookRegistry,           // class
  HookRunner,             // class
  runShellHook,           // (spec, input, logger?) => Promise<HookOutcome | null>
  hookMatcherMatches,     // (matcher, toolName?) => boolean
} from '@wrongstack/core';
import type {
  HookEvent,              // 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'SessionStart' | 'Stop'
  HookMatcher,            // string
  HookInput,              // the payload
  HookOutcome,            // the return shape
  InProcessHook,          // (input) => HookOutcome | void | Promise<HookOutcome | void>
  ShellHook,              // { command, matcher?, timeoutMs? }
  HookEntry,              // discriminated union of registered entries
  HookRunEnv,             // { cwd: string }
  HookRunnerOptions,      // { registry, logger?, allowShell?, sessionId? }
  PreToolUseResult,       // { block?, reason?, input? }
  PromptResult,           // { block?, reason?, additionalContext? }
  ShellHookSpec,          // { command, timeoutMs? }
} from '@wrongstack/core';
```

---

## Recipes

### Block a dangerous shell command

`scripts/guard-bash.sh`:

```bash
#!/usr/bin/env bash
input=$(cat)                                                 # HookInput JSON on stdin
cmd=$(printf '%s' "$input" | jq -r '.toolInput.command // ""')
if printf '%s' "$cmd" | grep -qE 'rm -rf|:\(\)\{'; then
  echo '{"decision":"block","reason":"dangerous command blocked"}'
  exit 0                                                     # (or: exit 2)
fi
# allow (no output)
```

`config.json`:

```jsonc
{
  "hooks": {
    "PreToolUse": [{ "matcher": "bash", "command": "./scripts/guard-bash.sh" }]
  }
}
```

### Rewrite tool arguments (in-process)

```ts
api.registerHook('PreToolUse', 'bash', (input) => {
  const cmd = (input.toolInput as { command?: string }).command ?? '';
  // Force `ls` to always show long form
  if (cmd.startsWith('ls ') && !cmd.includes('-l')) {
    return { modifiedInput: { ...input.toolInput, command: cmd.replace('ls', 'ls -l') } };
  }
  return {};
});
```

The rewritten input is **re-validated** against the tool's schema before it
runs — if your rewrite produces an invalid shape, the model gets a clear
validation error instead of a silent misuse.

### Append lint output after every edit

```ts
api.registerHook('PostToolUse', 'edit|write', async (input) => {
  const lint = await runLint(input.toolInput);
  return lint ? { additionalContext: `Lint:\n${lint}` } : {};
});
```

### Inject a project reminder at session start

```ts
api.registerHook('SessionStart', undefined, () => ({
  additionalContext: 'Reminder: this repo uses conventional commits.',
}));
```

### Run a teardown side effect at end of every turn

```ts
api.registerHook('Stop', undefined, async () => {
  await flushCoverageReport();
});
```

---

## Disabling hooks

| Mechanism | Scope | Effect |
|---|---|---|
| `--no-hooks` CLI flag | Whole session | Neither shell nor in-process hooks run; `HookRegistry` stays empty |
| `--bare` / untrusted session | Whole session | Shell hooks skipped (`allowShell: false`); in-process hooks still run |
| `allowShell: false` on `HookRunnerOptions` | Runner instance | Shell hooks skipped; in-process hooks still run |
| Plugin uninstall | That plugin's hooks | `drainByOwner` removes every in-process hook the plugin registered |
| `HookRegistry.clear()` | Whole registry | Every entry (shell + in-process) dropped; used in tests and full session teardown |
