# /todos — Session Todo List

## What it does

Manages an in-memory todo list scoped to the current session. Todos live in `ctx.todos` — all mutations go through `ctx.state.replaceTodos()` so the checkpoint writer and TUI stay in sync. For persistent plans across sessions, see `/plan`.

## Subcommands

| Usage | Effect |
|---|---|
| `/todos` | Show all todos |
| `/todos show` | Same as above |
| `/todos list` | Same as above |
| `/todos add <text>` | Add a pending todo with auto-generated id |
| `/todos done <id\|index>` | Mark one completed (matched by index, id, or fuzzy title) |
| `/todos remove <id\|index>` | Delete one (matched by index, id, or fuzzy title) |
| `/todos rm <id\|index>` | Alias for `remove` |
| `/todos delete <id\|index>` | Alias for `remove` |
| `/todos clear` | Clear all todos |

## Todo shape

```typescript
interface Todo {
  id: string;       // "todo_<timestamp>_<random7chars>"
  content: string;  // the task description
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string; // progressive form, e.g. "Building the project"
}
```

## ID matching priority

Commands that accept `<id|index>` (`done`, `remove`, `rm`, `delete`) match in this order:

1. **1-based index** — `done 3` → 3rd item
2. **Exact id match** — `done todo_174123456_abc1234`
3. **Case-insensitive substring** — `done bug` matches "Fix the Bug"

## TUI shortcuts

| Key | Panel | Mode |
|-----|-------|------|
| **F5** | Autonomy settings editor | Both modes, Esc to close |
| **F6** | Full-screen monitor overlay | Both modes, Esc to close |

## WebUI

The `TodosPanel` component renders the live list with status icons, colored borders, and hover-to-reveal ✕ remove buttons. Backed by `todos.updated` WS events from the server.

## Code reference

- `packages/cli/src/slash-commands/todos.ts` — slash command implementation
- `packages/core/src/core/context.ts` — `TodoItem` type
- `packages/tui/src/components/compact-todos-panel.tsx` — F5 panel
- `packages/tui/src/components/todos-monitor.tsx` — F6 overlay
- `packages/webui/src/components/TodosPanel.tsx` — WebUI panel
