# /worktree — Git worktree isolation for AutoPhase

Aliases: `/wt`

## What it does

AutoPhase can run each **phase** in its own git **worktree + branch** so that
`parallelizable` phases execute concurrently in isolated checkouts instead of
fighting over one shared working tree. When a phase completes, its branch is
**squash-merged** back into the base branch — sequentially and in dependency
order. Conflicts mark that worktree `needs-review` and the run continues.

`/worktree` lets you inspect and manage those worktrees.

Worktrees live under `<projectRoot>/.wrongstack/worktrees/<slug>/` (gitignored)
on branches named `wstack/ap/<slug>`. Clean merges auto-remove the worktree;
conflicted/failed ones are kept for inspection.

## Usage

```
/worktree [list | merge <branch> | prune | clean]
```

| Subcommand        | Action |
|-------------------|--------|
| `list` (default)  | Show current worktrees (`git worktree list`). |
| `merge <branch>`  | Squash-merge `<branch>` into the current branch. Rolls back on conflict. |
| `prune`           | Remove stale worktree administrative entries. |
| `clean`           | Remove all wstack-managed worktrees and `wstack/ap/*` branches. |

## Isolation toggle

Per-phase isolation is on by default when the project is a git repository.
Disable it with the environment variable:

```
WRONGSTACK_AUTOPHASE_WORKTREES=0
```

With isolation off (or outside a git repo), AutoPhase falls back to the legacy
single-tree, one-phase-at-a-time behavior.

## Visual surfaces

- **TUI** — a compact worktree panel sits beside the AutoPhase phase panel
  (branch · owner phase · `+ins/-del` · status). Press **Ctrl+T** for the
  full-screen worktree monitor (Ctrl+W is taken by delete-word).
- **WebUI** — the AutoPhase screen shows a live **swim-lane** band (one lane
  per worktree with flowing diff stats) and a **Graph** toggle that renders the
  worktrees as branches forking off — and folding back into — the base trunk.

## Related

- [`/autophase`](./autophase.md) — the run that creates these worktrees.
