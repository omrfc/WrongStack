# /commit /gitcheck /push - Git Workflow

These commands are registered by the built-in `wstack-git` plugin.

## /commit

Stages all changes with `git add .` and commits with an auto-generated conventional-commit message. It tries the session LLM provider first and falls back to local diff heuristics on failure.

**Flags:**
- `--dry-run` / `-n` - show what would be committed without committing
- `--no-llm` - skip LLM generation and use heuristics only

Message format: `<type>(<scope>): <short description>`.

**Type detection from diff stats:**

| Signal | Type |
|---|---|
| `_test.`, `.test.`, `.spec.` in filenames | `test` |
| `README`, `CHANGELOG`, `docs/`, `.md` | `docs` |
| `config`, `tsconfig`, `.json` | `chore` |
| Default | `feat` |

## /gitcheck

Silent status check for system-prompt integration. Returns an empty string when there are no uncommitted changes; returns a short warning when there are changes.

```text
3 uncommitted changes - consider /commit
```

Aliases: `/gcstatus`.

## /push

Runs `git push` to all configured remotes. It does not auto-commit; `/push` assumes you already committed.

**Flags:**
- `--dry-run` / `-n` - show what would be pushed
- `--force` / `-f` - force push

## Code reference

- `packages/core/src/plugins/git-plugin.ts`
- `packages/core/tests/plugins/git-plugin.test.ts`
