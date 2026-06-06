# /memory — Persistent Session Memory

## What it does

`/memory` reads and writes entries in the configured `MemoryStore`, which persists across sessions at `~/.wrongstack/memory.md` (user scope) and optionally project scope. Entries are key-value notes the agent can recall on future sessions.

## Subcommands

| Usage | Effect |
|---|---|
| `/memory` | Show all memory entries |
| `/memory show` | Same as above |
| `/memory list` | Same as above |
| `/memory remember <text>` | Add a new entry |
| `/memory forget <query>` | Delete entries matching query (case-insensitive substring match) |
| `/memory clear` | Clear all entries in all scopes |

## Memory store layers

`DefaultMemoryStore` supports two scopes:

| Scope | File | Shared across |
|---|---|---|
| User | `~/.wrongstack/memory.md` | All projects for this user |
| Project | `~/.wrongstack/projects/<hash>/memory.md` | Only this project |

`remember` writes to both scopes; `forget` and `clear` operate on whichever scope matches.

## Example session

```
/memory remember "Use pnpm, not npm, for this repo"
/memory remember "Auth module uses JWT RS256 — do not change algorithm"
/memory show
/memory forget "auth module"   → removes the JWT entry
```

## Code reference

- `packages/cli/src/slash-commands/memory.ts`
- `packages/core/src/storage/memory-store.ts`
- `packages/core/tests/storage/memory-store.test.ts`
