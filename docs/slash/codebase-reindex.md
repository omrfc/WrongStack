# /codebase-reindex — Rebuild the codebase symbol index

## What it does

Manually refreshes the symbol index that powers `codebase-search`
(SQLite at `~/.wrongstack/projects/<hash>/codebase-index/index.db`).

The index is normally kept fresh automatically — a background scan runs at
session start, and individual files are reindexed as the agent edits them or as
you change them in your editor. Use this command when you want to force a refresh
explicitly, e.g. after a large branch switch, a merge, or bulk external changes.

## Usage

| Usage | Output |
|---|---|
| `/codebase-reindex` | Incremental reindex — only files whose mtime changed are reparsed (fast). |
| `/codebase-reindex force` | Clear the index and rebuild every file from scratch. |

Aliases: `/reindex`. The `force` argument also accepts `--force` / `-f`.

## Output

Prints a one-line summary when done, for example:

```
✓ codebase index updated — 2160 symbols · 60 files · 1234ms
```

(`rebuilt` instead of `updated` when run with `force`.) If some files failed to
parse, the count is reported on a second line; the rest of the index still
updates.

## Notes

- Runs through the shared background-indexer mutex, so it serializes safely with
  the session-start scan and live per-edit reindexes — no risk of concurrent
  SQLite writers.
- Respects the project-root `.gitignore` plus the built-in ignore list
  (`node_modules`, `.git`, `dist`, `build`, …).
- Disabling automatic indexing (`WRONGSTACK_INDEX_ON_START=0`, or
  `indexing.onSessionStart: false` in config) does not affect this command — it
  always runs on demand.
- Every index run is guarded by a watchdog timeout (default 120s full / 30s
  per-file incremental, configurable via `indexing.indexTimeoutMs`) and a
  circuit breaker: after 3 consecutive failures or timeouts, indexing pauses
  for 60s and background reindexes are dropped instead of queuing — so a
  wedged index can never lock the terminal. The status bar shows
  `⚙ index paused` while the circuit is open. Running this command resets the
  breaker and retries immediately.
