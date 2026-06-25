# /tools — Registered Tool Catalog

## What it does

Lists all registered tools from the `ToolRegistry` with their name, owner package, mutability flag, permission level, and description detail mode. Risk tier is not currently rendered; use the source catalog or tool help when auditing YOLO/destructive behavior.

## Output format

```
Tools (N) description detail via /tool <name> simple|extend:
  tool                         owner                        rw   perm     description
  read                         [@wrongstack/tools]          ro   auto     desc:extend
  write                        [@wrongstack/tools]          mut  confirm  desc:extend
  bash                         [@wrongstack/tools]          mut  confirm  desc:simple
  ...
```

Each line: `name [owner] mut|ro permission desc:simple|desc:extend`

| Flag | Meaning |
|---|---|
| `mut` | Tool modifies filesystem or external state |
| `ro` | Read-only tool |
| Permission | Declared permission: `auto`, `confirm`, or `deny` |
| Description mode | `desc:extend` is the default full description; `desc:simple` is the shorter 1-2 line mode set by `/tool <name> simple` |

## Tools included by default

See `packages/tools/src/builtin.ts` for the full list. Common categories:

- **Filesystem:** read, write, edit, replace, glob, grep, tree, patch, diff, json
- **Execution:** bash, exec, git
- **Network:** fetch, search
- **Project:** lint, format, typecheck, test, install, audit, outdated, logs, document, scaffold
- **Agent control:** todo, plan, tool-search, tool-use, batch-tool-use, tool-help, memory, mode

## Code reference

- `packages/cli/src/slash-commands/tools.ts`
- `packages/core/src/registry/tool-registry.ts`
- `packages/tools/src/builtin.ts`
- `packages/tools/src/index.ts`
