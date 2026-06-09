# /tasks — Structured Task Management

Manages structured tasks with dependencies, types, priorities, and agent
assignment. More powerful than `/todos` — supports dependency ordering,
status transitions, and subagent assignment.

## Usage

| Usage | Effect |
|---|---|
| `/tasks` | Show task progress + list |
| `/tasks show` | Same as no args |
| `/tasks add <title> [type] [priority]` | Add a task |
| `/tasks start <id\|index>` | Mark task in-progress |
| `/tasks done <id\|index>` | Mark task completed |
| `/tasks fail <id\|index>` | Mark task failed |
| `/tasks status <id> <status>` | Set exact status |
| `/tasks depends <id> <depId...>` | Set dependencies |
| `/tasks assign <id> <agent>` | Assign to agent/subagent |
| `/tasks promote <id>` | Promote task to todo items |
| `/tasks clear` | Remove all tasks |

## Task properties

| Property | Values |
|---|---|
| **Type** | `feature`, `bugfix`, `refactor`, `docs`, `test`, `chore` |
| **Priority** | `critical`, `high`, `medium`, `low` |
| **Status** | `pending`, `in_progress`, `blocked`, `review`, `completed`, `failed` |

## Finding tasks

Tasks can be referenced by:
- **1-based index** — `/tasks done 1`
- **Exact ID** — `/tasks start task_1234567890_abc123`
- **Substring match** — `/tasks done auth` (matches title containing "auth")

## Examples

```bash
/tasks add "Fix auth race condition" bugfix high
/tasks add "Write API docs" docs medium
/tasks start 1
/tasks depends 2 1           # Task 2 depends on task 1
/tasks assign 1 bug-hunter   # Assign to subagent
/tasks status 1 in_progress
/tasks done 1
/tasks promote 2             # Promote to /todos for the AI to see
```

## Progress display

```
Tasks — 2/5 completed

  ⏳ #1 Fix auth race condition [bugfix] [high]
  ✅ #2 Write API docs [docs] [medium]
  ⏸ #3 Refactor core [refactor] [medium] — blocked by #1
```

## vs /todos

| | `/tasks` | `/todos` |
|---|---|---|
| **Purpose** | Structured project management | Session-level checklist |
| **Dependencies** | ✅ | ❌ |
| **Types/priorities** | ✅ | ❌ |
| **Agent assignment** | ✅ | ❌ |
| **Promote to todos** | ✅ | — |
| **Storage** | Per-session task file | In-memory context |

Use `/tasks` for project planning, `/todos` for the AI's working checklist.
`/tasks promote <id>` bridges the two — it creates todo items the AI can act on.

## Code reference

- `packages/cli/src/slash-commands/tasks.ts`
- `packages/core/src/tasks/` — TaskFile, TaskItem types
