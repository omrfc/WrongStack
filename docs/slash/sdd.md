# /sdd — AI-Driven Spec-Driven Development

## What it does

`/sdd` runs a structured AI-driven workflow for building features: the AI asks clarifying questions, generates a spec, creates an implementation plan, breaks it into tasks, and executes them. Each phase transitions via `/sdd approve`.

## Phase flow

```
questioning → spec_review → implementation → task_review → executing → done
```

1. **`/sdd new [title]`** — Start a session. AI prompts you with contextual questions about the feature.
2. **Answer naturally** — The AI continues the interview.
3. **`/sdd approve`** — When the AI has gathered enough, it auto-generates the spec. `/sdd approve` moves to `spec_review`.
4. **Review spec** — Run `/sdd spec` to read it.
5. **`/sdd approve`** — Approve spec → moves to `implementation`. AI generates implementation plan + tasks.
6. **`/sdd approve`** — Approve tasks → moves to `executing`. AI executes tasks one by one.
7. **`/sdd done <N>`** — Mark a task done by number or fuzzy title match.
8. **`/sdd tasks`** — View live progress with a progress bar, sorted by status.
9. **`/sdd next`** — See the next task the AI should work on (and what's blocking it).
10. **`/sdd critical`** — Analyze which tasks are on the critical path and causing bottlenecks.

## Auto-detection patterns

The session can auto-detect task completion from AI output:
- `✅ Task: <title>` or `✅ <title>`
- `Task N: complete/done/finished`
- `Completed: <title>` or `Done: <title>`
- `/sdd done N`

## Key subcommands

| Usage | Effect |
|---|---|
| `/sdd new [title]` | Start new session (add `--force` to skip resume check) |
| `/sdd resume` | Resume saved session |
| `/sdd approve` | Advance to next phase |
| `/sdd spec` | Show current session's spec |
| `/sdd plan` | Show implementation plan |
| `/sdd tasks` | Show task list with progress bar (sorted by status) |
| `/sdd next` | Show the next executable task + blockers |
| `/sdd done <N>` | Mark task done (by number or fuzzy title match) |
| `/sdd undo` | Undo last task completion |
| `/sdd skip <N>` | Skip a task back to pending |
| `/sdd fail <N>` | Mark a task as failed |
| `/sdd review <N>` | Send a task to review |
| `/sdd edit <N> <text>` | Edit task title or description |
| `/sdd graph` | Visualize task dependency graph |
| `/sdd critical` | Analyze critical path + bottlenecks |
| `/sdd status` | Full session status with phase, spec preview, and task breakdown |
| `/sdd cancel` | Cancel and delete session |
| `/sdd list` | List saved specs |
| `/sdd show <id>` | Show saved spec details |
| `/sdd templates` | List available templates |
| `/sdd from <template-id>` | Create draft from template |
| `/sdd version <id>` | Show version history |

## Goal & Eternal Mode

`/sdd` pairs with `/goal` for autonomous execution:

| Command | Effect |
|---------|--------|
| `/goal set <text>` | Set an autonomous mission |
| `/goal pause` | Pause at end of current iteration |
| `/goal resume` | Resume a paused goal |
| `/goal journal [N]` | Show recent journal entries |
| `/goal clear` | Clear goal and stop eternal mode |
| `/autonomy eternal` | Run the goal loop indefinitely |
| `/autonomy stop` | Stop eternal mode |

**Eternal stage flow:** `decide → execute → reflect → sleep | paused | stopped`

The stage is shown in real-time during `/autonomy eternal` mode. Use `/goal pause` to gracefully stop after the current iteration.

## Storage

```
<projectRoot>/.wrongstack/
  sdd-session.json     ← active session (resumable)
  specs/              ← approved/archived specs
  task-graphs/        ← task graph state per spec
```

## Code reference

- `packages/cli/src/slash-commands/sdd.ts`
- `packages/core/src/sdd/` — `SpecParser`, `TaskGenerator`, `TaskTracker`, `TaskFlow`, `AISpecBuilder`
- `packages/core/src/storage/spec-store.ts`
- `packages/core/src/storage/task-graph-store.ts`