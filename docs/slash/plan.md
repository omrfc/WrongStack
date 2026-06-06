# /plan - Strategic Plan Board

## What it does

`/plan` is the persistent counterpart to `/todos`. Plan items are atomic-written to the project's `projectPlan` path on every mutation and read back by the built-in `wstack-plan` plugin whenever the command runs.

While `/todos` is a moment-to-moment task board the LLM mutates per turn, `/plan` captures the overall approach before any work begins.

## Subcommands

| Usage | Effect |
|---|---|
| `/plan` | Show all plan items |
| `/plan show` | Same as above |
| `/plan add <title>` | Add a new item |
| `/plan start <id\|#>` | Mark item `in_progress` |
| `/plan done <id\|#>` | Mark item `done` |
| `/plan remove <id\|#>` | Remove item |
| `/plan promote <id\|#> [subtask ...]` | Convert a plan item to todos, optionally splitting into manual subtasks |
| `/plan derive <id\|#>` | Convert a plan item to todos using built-in derivation logic |
| `/plan template list` | List available plan templates |
| `/plan template use <name>` | Apply a template by appending its items |
| `/plan clear` | Clear all items |

## Plan item shape

```typescript
interface PlanItem {
  id: string;
  title: string;
  details?: string;
  status: 'open' | 'in_progress' | 'done';
  createdAt: string;  // ISO timestamp
  updatedAt: string;  // ISO timestamp
}
```

## Templates

Plan templates are predefined item sets for common workflows. Built-in templates include:

- `new-feature`
- `bug-fix`
- `refactor`
- `release`
- `security-audit`
- `onboarding`

## `promote` vs `derive`

Both convert a plan item to todos, but:

| Command | Subtask splitting | Updates plan item status |
|---|---|---|
| `/plan promote <id> subA subB` | Manual - you specify subtask titles | Yes -> `in_progress` |
| `/plan derive <id>` | Automatic logic derives todos from the plan item | Yes -> `in_progress` |

## Code reference

- `packages/core/src/plugins/plan-plugin.ts`
- `packages/core/src/storage/plan-store.ts`
- `packages/core/src/storage/plan-templates.ts`
- `packages/core/tests/storage/plan-store.test.ts`
- `packages/core/tests/plugins/plan-plugin.test.ts`
