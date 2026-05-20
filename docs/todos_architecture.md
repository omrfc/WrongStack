# Todos System Architecture

> **Scope:** This document describes the `todos` subsystem in WrongStack — the live task board that the LLM mutates per-turn, its persistence model, integration points across CLI / TUI / WebUI, and the relationship to the higher-level `plan` system.
>
> **Last updated:** 2026-05-20

---

## 1. Overview

The **todos system** is WrongStack's moment-to-moment task tracker. It lives in the mutable conversation state (`Context.todos`) and is surfaced to the model via the `todo` tool, to the user via slash commands (`/todos`), and to frontends via event broadcasts. Its design goals are:

1. **Simplicity** — a small, flat list the model can read and write in a single tool call.
2. **Observability** — every mutation is an event; subscribers (TUI, WebUI, checkpoint writer) react without polling.
3. **Durability** — an atomic on-disk checkpoint rehydrates the board on `wstack resume`.
4. **Single-writer** — only one item may be `in_progress` at a time; the tool enforces this invariant.

The todos system is intentionally **not** a project-management layer. For roadmap-level planning there is a separate `/plan` command backed by `plan-store.ts` (see §6).

---

## 2. Data Model

### 2.1 `TodoItem`

```ts
// packages/core/src/core/context.ts
export interface TodoItem {
  id: string;                          // opaque, caller-generated
  content: string;                     // imperative description ("Build the project")
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;                 // progressive aspect ("Building the project")
}
```

- **`activeForm`** is optional. When present, the TUI and formatter prefer it for `in_progress` rows so the board reads like a live status line.
- **No nesting, no priorities, no deadlines.** Those belong in `/plan` or in the conversation itself.

### 2.2 Invariants

| Invariant | Enforcer | Failure mode |
|-----------|----------|--------------|
| Exactly one `in_progress` item | `todoTool.execute` | Extra `in_progress` items are downgraded to `pending` (first wins) |
| `id` + `content` required | `todoTool.execute` | Items missing either field are silently dropped |
| `status` ∈ enum | JSON Schema | Provider-level validation rejects invalid values before execution |

---

## 3. State Layer (`ConversationState`)

Todos live inside `Context`, but mutations should go through `ConversationState` so observers stay in sync.

```
Context (mutable bag)
├── messages: Message[]
├── todos: TodoItem[]          ← raw array, direct mutation bypasses observers
├── readFiles, fileMtimes, meta
│
└── state: ConversationState   ← observable wrapper
    ├── replaceTodos(todos)    → emits `todos_replaced`
    ├── replaceMessages(msgs)  → emits `messages_replaced`
    └── onChange(handler)      → subscribes to the event stream
```

### 3.1 Why two paths exist

- **Legacy tools** (and some tests) mutate `ctx.todos.push(...)` directly. This is fast but invisible to subscribers.
- **New code** uses `ctx.state.replaceTodos([...])`, which fires `StateChange` events.

The checkpoint writer (§4) and TUI auto-echo (§5.2) both subscribe to `onChange`; if a tool mutates the raw array, those subscribers miss the update until the *next* observed mutation coalesces them.

### 3.2 StateChange types

```ts
// packages/core/src/core/conversation-state.ts
export type StateChange =
  | { kind: 'message_appended'; message: Message }
  | { kind: 'messages_replaced'; messages: readonly Message[] }
  | { kind: 'todos_replaced'; todos: readonly TodoItem[] }
  | { kind: 'meta_set'; key: string; value: unknown }
  | { kind: 'meta_deleted'; key: string }
  | { kind: 'meta_cleared' };
```

---

## 4. Persistence (`todos-checkpoint.ts`)

### 4.1 File format

```ts
// packages/core/src/storage/todos-checkpoint.ts
export interface TodosCheckpointFile {
  version: 1;
  sessionId: string;
  updatedAt: string;   // ISO-8601
  todos: TodoItem[];
}
```

- Stored at `<projectSessions>/<session-id>.todos.json`
- Written atomically via `atomicWrite` with `0o600` permissions
- Version field makes future migrations trivial

### 4.2 Lifecycle

```
Session start
│
├─ resume path ──► loadTodosCheckpoint(path)
│                  └─► if found, ctx.state.replaceTodos(restored)
│
├─ new path ─────► (empty list, no file yet)
│
└─► attachTodosCheckpoint(state, path, sessionId)
    └─ subscribes to 'todos_replaced' events
        └─ debounced 150ms → atomic write
```

### 4.3 Debouncing & flush-on-detach

The subscriber uses a 150 ms debounce so a burst of edits (e.g. the LLM marking three items done in one tool call) coalesces into a single disk write. The `detach` function flushes any pending write before unsubscribing, preventing data loss at shutdown.

```ts
const detach = attachTodosCheckpoint(state, filePath, sessionId);
// ... later ...
await detach();  // guaranteed flush
```

### 4.4 Error posture

- **Read failure** (missing / corrupt file) → returns `null`, treated as "no prior state"
- **Write failure** → logged to `console.warn`, does **not** throw; a lost checkpoint must not crash the agent run

---

## 5. Tool: `todo`

### 5.1 Schema

```ts
// packages/tools/src/todo.ts
export const todoTool: Tool<TodoInput, TodoOutput> = {
  name: 'todo',
  category: 'Session',
  description: 'Replace the current todo list with a new set of items.',
  usageHint:
    'Use for multi-step tasks. Replace the full list on each call. ' +
    'At most ONE task may be in_progress at a time.',
  permission: 'auto',
  mutating: false,          // replaces in-place; no external side effects
  timeoutMs: 1_000,
  inputSchema: { /* array of TodoItem objects */ },
};
```

### 5.2 Execution semantics

1. Validate `input.todos` is an array.
2. Filter out items missing `id` or `content`.
3. Enforce single-`in_progress` invariant (first wins, rest → `pending`).
4. Call `ctx.state.replaceTodos(items)` — triggers `todos_replaced` event.
5. Return `{ count, in_progress }`.

### 5.3 Why "replace the full list"

The tool is **not** CRUD. The LLM sends the *entire* desired board on every call. This avoids race conditions (the model's view of the board is always the ground truth) and eliminates the need for separate add/remove/done tools.

---

## 6. Slash Command: `/todos`

```
/todos              → show formatted list
/todos show         → same
/todos clear        → wipe all items
/todos add <text>   → append a pending item
/todos done <id|#>  → mark matched item completed
```

- Implemented in `packages/cli/src/slash-commands/todos.ts`
- Uses `randomUUID()` for IDs when user adds items manually
- `done` matches by 1-based index, exact `id`, or substring fuzzy search
- Mutates `ctx.todos` **directly** (not via `state.replaceTodos`) — this is a known gap; the checkpoint subscriber still catches it on the *next* observed mutation, but an immediate `/todos` followed by session exit could lose the manual edit. See §9 (Fix Plan).

---

## 7. Rendering

### 7.1 Text formatter (`formatTodosList`)

```
Todos (1/3 done):
   1. [ ] Write tests
   2. [~] Building the project      ← activeForm used
   3. [x] Initialize repo
```

- Source: `packages/core/src/utils/todos-format.ts`
- Used by:
  - `/todos` slash command (CLI)
  - TUI auto-echo after `todo` tool execution
  - Any future consumer that needs a plain-text snapshot

### 7.2 TUI integration

In `packages/tui/src/app.tsx`, the `tool.executed` event listener checks `e.name === 'todo'` and, on success, dispatches an `info` entry containing `formatTodosList(agent.ctx.todos)`. This means the user sees the updated board in chat history immediately after the model edits it — no polling required.

### 7.3 WebUI integration

The WebUI server (`packages/webui/src/server/index.ts`) broadcasts `todos.updated` events on every `tool.executed` and also handles two client messages:

- `todos.get` — returns current snapshot on demand
- `todos.clear` — wipes the array in place and broadcasts `todos.updated` with `[]`

---

## 8. Relationship to `/plan`

| Aspect | `/todos` (todos system) | `/plan` (plan system) |
|--------|------------------------|----------------------|
| **Granularity** | Per-turn task board | Strategic roadmap |
| **Mutated by** | LLM via `todo` tool | User via slash command |
| **Persistence** | `todos-checkpoint.ts` (auto) | `plan-store.ts` (auto) |
| **Lifespan** | Session-scoped, derived | Session-scoped, canonical |
| **Typical use** | "Build the project → Test → Deploy" | "Refactor auth layer → Add OAuth → Audit" |

Both systems can coexist: a user might set up a high-level plan with `/plan`, then the LLM breaks the current plan step into concrete todos.

---

## 9. Feature Plan

### 9.1 Short-term (next 1–2 releases)

| # | Feature | Motivation | Files touched |
|---|---------|------------|---------------|
| 1 | **Fix `/todos` direct-mutation gap** | `/todos add` and `/todos done` mutate `ctx.todos` directly, bypassing `ConversationState`. This can lose edits if the session exits before the next observed mutation. | `packages/cli/src/slash-commands/todos.ts` |
| 2 | **Todo item ordering** | Allow the LLM to re-order items (e.g. move a blocked task down). The current "replace full list" semantics already support this, but the tool description should explicitly mention ordering. | `packages/tools/src/todo.ts` |
| 3 | **WebUI todo panel** | Render the live todo list in a dedicated sidebar, updated via `todos.updated` WS events. | `packages/webui/src/components/` |
| 4 | **Todo count in status bar** | Surface `in_progress / pending / completed` counts in the CLI prompt and WebUI header. | `packages/cli/src/repl.ts`, `packages/webui/src/server/index.ts` |

### 9.2 Medium-term (next 3–6 releases)

| # | Feature | Motivation | Files touched |
|---|---------|------------|---------------|
| 5 | **Todo → Plan bridge** | Allow promoting a todo item into a plan item (and vice versa) so users can escalate a task from "today's board" to "project roadmap". | `packages/cli/src/slash-commands/todos.ts`, `packages/cli/src/slash-commands/plan.ts` |
| 6 | **Todo history / undo** | Keep a rolling log of todo mutations (last N states) so the user can undo an accidental `clear` or a bad LLM replacement. | `packages/core/src/storage/todos-checkpoint.ts`, `packages/core/src/core/conversation-state.ts` |
| 7 | **Per-todo notes / subtasks** | Optional `notes?: string` and `subtasks?: TodoItem[]` fields for items that need more detail without promoting to a plan. | `packages/core/src/core/context.ts`, `packages/core/src/utils/todos-format.ts` |
| 8 | **Todo deadlines / reminders** | Optional `dueAt?: string` with a lightweight reminder hook that fires via the event bus when a deadline approaches. | `packages/core/src/core/context.ts`, `packages/core/src/kernel/events.ts` |

### 9.3 Long-term / exploratory

| # | Feature | Motivation |
|---|---------|------------|
| 9 | **Cross-session todo archive** | Persist completed todos across sessions for project retrospectives and audit trails. |
| 10 | **Todo templates** | Pre-defined todo lists for common workflows ("new feature", "bug fix", "release") that the LLM can instantiate with one tool call. |
| 11 | **Collaborative todos** | Fleet / multi-agent scenarios where subagents report progress on shared todo items via the fleet bus. |

---

## 10. Fix Plan

### 10.1 Known bugs / gaps

| ID | Issue | Severity | Fix | ETA |
|----|-------|----------|-----|-----|
| F-1 | `/todos add` and `/todos done` mutate `ctx.todos` directly, skipping `ConversationState` observers. A session exit immediately after these commands may not flush the checkpoint. | **Medium** | Route all mutations through `ctx.state.replaceTodos()` in the slash command. | Short-term |
| F-2 | `todoTool` declares `mutating: false` but it *does* mutate conversation state. This is a metadata lie that could mislead permission policies or UI indicators. | **Low** | Change `mutating: true` (or document why `false` is intentional — it has no *external* side effects). | Short-term |
| F-3 | `todos-checkpoint.ts` does not validate `activeForm` on load. A corrupt checkpoint with a non-string `activeForm` would pass validation and later crash the formatter. | **Low** | Add `typeof t.activeForm === 'string'` to the load filter, or make the field optional in validation. | Short-term |
| F-4 | No test covers the `/todos` slash command directly. The existing tests only cover the `todoTool` and the checkpoint layer. | **Low** | Add unit tests for `buildTodosCommand` covering `show`, `add`, `done`, `clear`, and error paths. | Short-term |
| F-5 | WebUI `todos.clear` uses `context.todos.length = 0` (direct mutation) instead of `context.state.replaceTodos([])`. Same observer-skip issue as F-1. | **Medium** | Replace with `context.state.replaceTodos([])` and verify the `todos.updated` broadcast still fires. | Short-term |
| F-6 | WebUI `session.start` replay handler drops assistant text when a message mixes `text` + `tool_use` blocks. The `text` accumulator is reset to `''` on every `tool_use` without flushing, so the preceding text never gets emitted as a message. | **High** | Flush accumulated text before emitting `tool_use` in the replay loop. | **Fixed** |

### 10.2 Refactoring candidates

| ID | Idea | Risk | Reward |
|----|------|------|--------|
| R-1 | **Merge todos and plan stores** | High — different lifecycles, different consumers | Simpler persistence layer, single rehydration path |
| R-2 | **Extract `TodoItem` into its own schema file** | Low | Easier to share with validation libraries (Zod, etc.) |
| R-3 | **Make `Context.todos` private, force `state.todos`** | Medium — breaks legacy tools | Guarantees observer consistency, eliminates F-1 class bugs |
| R-4 | **Add a `TodoRegistry` abstraction** | Medium | Would enable plugins to register custom todo renderers, validators, or hooks |

---

## 11. File Index

| File | Role |
|------|------|
| `packages/core/src/core/context.ts` | `TodoItem` interface, `Context` class (holds raw `todos` array) |
| `packages/core/src/core/conversation-state.ts` | Observable wrapper, `replaceTodos()`, `onChange()` |
| `packages/core/src/storage/todos-checkpoint.ts` | Atomic save/load, `attachTodosCheckpoint()` subscriber |
| `packages/core/src/utils/todos-format.ts` | `formatTodosList()` text renderer |
| `packages/tools/src/todo.ts` | `todoTool` definition and execution logic |
| `packages/cli/src/slash-commands/todos.ts` | `/todos` slash command implementation |
| `packages/cli/src/wiring/session.ts` | Session setup: restore todos on resume, attach checkpoint |
| `packages/cli/src/slash-commands/clear.ts` | `/clear` wipes todos via `state.replaceTodos([])` |
| `packages/cli/src/slash-commands/context.ts` | `/context` prints todo counts |
| `packages/tui/src/app.tsx` | TUI auto-echo of todo list after `todo` tool execution |
| `packages/webui/src/server/index.ts` | WebUI WS handlers for `todos.get`, `todos.clear`, and `todos.updated` broadcasts |
| `packages/webui/src/hooks/useWebSocket.ts` | WebSocket event handlers including `session.start` replay hydration |
| `packages/core/tests/storage/todos-checkpoint.test.ts` | Checkpoint round-trip, debounce, detach-flush tests |
| `packages/tools/tests/todo.test.ts` | Tool execution and single-`in_progress` enforcement tests |
| `packages/core/tests/core/run-env-state.test.ts` | `ConversationState` observer tests (including `replaceTodos`) |

---

## 12. Glossary

| Term | Definition |
|------|------------|
| **Checkpoint** | An atomic on-disk snapshot of `todos` tied to a session ID. |
| **Direct mutation** | Modifying `ctx.todos` or `ctx.messages` without going through `ConversationState`. Fast but invisible to observers. |
| **Observed mutation** | A change routed through `ctx.state.replaceTodos()` etc., which fires `StateChange` events. |
| **Plan** | The strategic counterpart to todos; managed by `/plan` and stored separately. |
| **Single-writer invariant** | At most one todo may have `status === 'in_progress'` at any time. |
