# /sync - GitHub-Backed Cloud Sync

Registered by the built-in `wstack-sync` plugin. Syncs selected WrongStack user
data categories to a GitHub repository using a personal access token.

## Usage

| Command | Effect |
|---|---|
| `/sync` | Show sync status |
| `/sync status` | Same as `/sync` |
| `/sync enable owner/repo TOKEN [cat1 cat2 ...]` | Enable sync for a GitHub repository |
| `/sync disable` | Disable sync while keeping local data |
| `/sync push` | Upload selected categories |
| `/sync pull` | Download selected categories |
| `/sync categories list` | Show selected and available categories |
| `/sync categories add <name>` | Add a category to the sync set |
| `/sync categories remove <name>` | Remove a category from the sync set |

Without explicit categories, `/sync enable` enables all categories from
`ALL_SYNC_CATEGORIES`.

The GitHub token is written to `~/.wrongstack/sync.json` via `atomicWrite`; when
a vault is available, it is encrypted before persistence.

## Code Reference

- `packages/core/src/plugins/sync-plugin.ts`
- `packages/core/src/storage/cloud-sync.ts`
- `packages/core/src/types/config.ts`
