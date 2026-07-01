# /review — Trigger a Chimera code review

Manually reviews the files changed in this session using the **Chimera**
review subagent (the same engine that powers automatic post-edit reviews),
with full read/grep/lint tool access.

Alias: `/cr`.

## Usage

| Command | Effect |
|---|---|
| `/review` | Review all changed files (added + modified, up to 30). |
| `/review --limit <n>` | Raise/lower the file cap (1–200; also `-n`). |
| `/review --files <substr>` | Only review changed files whose path contains `<substr>` (also `--file`). |

## What counts as "changed"

The command runs `git status --porcelain` in the current working directory:
added (`A`, `??`) and modified (`M`) files are candidates; deleted files and
anything under `.wrongstack/` are skipped. When more files changed than the
cap allows, the message tells you how many were left out and the exact
`--limit` to include them.

## How the review runs

File contents are read and a `chimera.review_needed` event is emitted with
the current provider/model; the execution layer picks it up and runs the
Chimera subagent asynchronously. The review report appears in chat history
shortly after the command returns — the command itself only confirms the
dispatch:

```
🦂 Chimera review triggered for 12 file(s).
The review report will appear in chat history shortly.
```

## Examples

```
/review
/review --limit 60
/review --files packages/core
```

See also: `/security` (security-focused diagnostics), `/commit` (commit the
reviewed changes).
