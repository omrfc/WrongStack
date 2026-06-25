# /sdd - AI-Driven Spec-Driven Development

## What it does

`/sdd` runs a structured AI-driven workflow for building features: the AI asks clarifying questions, generates a spec, creates an implementation plan, breaks it into tasks, and executes them. Each phase advances through `/sdd approve`.

## Phase flow

```text
questioning -> spec_review -> implementation -> task_review -> executing -> done
```

1. **`/sdd new [title]`** - Start a session. AI prompts you with contextual questions about the feature.
2. **Answer naturally** - The AI continues the interview.
3. **`/sdd approve`** - When enough context exists, the AI generates the spec. `/sdd approve` moves to `spec_review`.
4. **Review spec** - Run `/sdd spec` to read it.
5. **`/sdd approve`** - Approve spec -> moves to `implementation`; AI generates implementation plan and tasks.
6. **`/sdd approve`** - Approve tasks -> moves to `executing`; AI executes tasks one by one.
7. **`/sdd done <N>`** - Mark a task done by number or fuzzy title match.
8. **`/sdd tasks`** - View live progress with a progress bar, sorted by status.
9. **`/sdd next`** - See the next task the AI should work on and what blocks it.
10. **`/sdd critical`** - Analyze which tasks are on the critical path.

## Auto-detection patterns

The session can auto-detect task completion from AI output:

- `Task: <title>` or `<title>`
- `Task N: complete/done/finished`
- `Completed: <title>` or `Done: <title>`
- `/sdd done N`

## Key subcommands

| Usage | Effect |
|---|---|
| `/sdd new [title]` | Start new session (add `--force` to skip resume check) |
| `/sdd resume` | Resume saved session |
| `/sdd approve` | Advance to the next phase |
| `/sdd spec` | Show current session's spec |
| `/sdd plan` | Show implementation plan |
| `/sdd tasks` | Show task list with progress bar |
| `/sdd next` | Show the next executable task and blockers |
| `/sdd done <N>` | Mark task done by number or fuzzy title match |
| `/sdd undo` | Undo last task completion |
| `/sdd skip <N>` | Move a task back to pending |
| `/sdd fail <N>` | Mark a task as failed |
| `/sdd review <N>` | Send a task to review |
| `/sdd edit <N> <text>` | Edit task title or description |
| `/sdd graph` | Visualize task dependency graph |
| `/sdd critical` | Analyze critical path and bottlenecks |
| `/sdd status` | Full session status with phase, spec preview, and task breakdown |
| `/sdd cancel` | Cancel and delete session |
| `/sdd list` | List saved specs |
| `/sdd show <id>` | Show saved spec details |
| `/sdd templates` | List available templates |
| `/sdd from <template-id>` | Create draft from template |
| `/sdd version <id>` | Show version history |
| `/sdd parallel [slots]` | Start the parallel SDD fan-out when wired by the host |
| `/sdd stop` | Stop the current parallel SDD fan-out |
| `/sdd retry-failed` (alias `retry-all`) | Requeue every failed task in the active parallel run to pending |
| `/sdd split <id> <A ; B>` | Split a task in the active run into `;`-separated sub-tasks (each `Title :: description`, description optional). Refused while the task is running |

## Parallel run robustness

A `/sdd parallel` run is guarded so it never silently gets stuck, explodes, or
goes bad:

- **Completion gate.** A task that sets `metadata.verificationCommand` only
  completes when that command exits 0 (run in the task's worktree cwd, 180 s
  timeout). Attach one per task from the WebUI board's task drawer, or omit it
  (the default) for a fast run. The same gate runs from both the CLI and the
  standalone WebUI (shared `makeCommandVerifier`). With
  `WRONGSTACK_SDD_VERIFY_FROM_ACCEPTANCE=1` (off by default), task generation
  also derives a `verificationCommand` from any acceptance criterion that carries
  a runnable marker (`$ <cmd>`, or a `run:`/`verify:`/`cmd:` prefix).
- **Mergeable worktrees.** A completed task is only marked done after a clean
  squash-merge of its worktree. An unresolved conflict retries on a fresh base,
  then fails — never a silent "completed". An opt-in heuristic resolver is
  available via `WRONGSTACK_SDD_CONFLICT_RESOLVER=prefer-incoming|prefer-base`
  (default off → the conservative retry-then-fail path).
- **Failure supervisor.** When a task exhausts its retries, a `BrainArbiter`
  decides retry / reassign (rotate the worker model through the fallback chain) /
  split (LLM decomposition) / fail. The CLI keeps the conservative bounded-retry
  default; the standalone WebUI lets the LLM layer pick (its brain can't block on
  a human prompt).
- **Live board events.** `verification failed`, `merge conflict`, `split into N`,
  and supervisor decisions stream to the WebUI activity feed and the TUI overlay.

## Goal and Eternal Mode

`/sdd` pairs with `/goal` for autonomous execution:

| Command | Effect |
|---|---|
| `/goal set <text>` | Set an autonomous mission |
| `/goal pause` | Pause at end of current iteration |
| `/goal resume` | Resume a paused goal |
| `/goal journal [N]` | Show recent journal entries |
| `/goal clear` | Clear goal and stop eternal mode |
| `/autonomy eternal` | Run the goal loop indefinitely |
| `/autonomy stop` | Stop eternal mode |

**Eternal stage flow:** `decide -> execute -> reflect -> sleep | paused | stopped`

The stage is shown in real time during `/autonomy eternal` mode. Use `/goal pause` to gracefully stop after the current iteration.

## Storage

```text
<projectRoot>/.wrongstack/
  sdd-session.json
  specs/
  task-graphs/
```

## Code reference

- `packages/cli/src/slash-commands/sdd.ts`
- `packages/cli/src/slash-commands/sdd/`
- `packages/core/src/sdd/`
- `packages/core/tests/sdd/spec-store.test.ts`
- `packages/core/tests/sdd/task-graph-store.test.ts`
