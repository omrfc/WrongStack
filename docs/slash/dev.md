# /dev — Run a Shell Command from Chat

## What it does

Executes a shell command from the chat input and displays its output inline in
the chat history. The command runs in the current working directory with a 60 s
timeout. Output is capped at 500 lines.

**The LLM does not see the output.** This is a developer convenience shortcut —
equivalent to switching to a terminal tab and running the command yourself. For
commands the LLM should observe, use the `exec` tool instead.

## Usage

```
/dev <shell command>    Run a command and show the output.
```

**Examples:**

```
/dev pnpm release:check
/dev git diff --stat
/dev ls -la src/
/dev cat CHANGELOG.md | head -20
```

## Output format

```
$ pnpm release:check  OK  2341ms
──
> wrongstack@0.118.1 release:check
> pnpm typecheck && pnpm test && pnpm build
…
──
```

- **Header**: `$ <command>` in cyan, a status chip (`OK` green / `EXIT N` red / `TIMEOUT` red), and elapsed milliseconds.
- **Body**: stdout + stderr combined, delimited by `──` lines.
- **Truncation**: Output beyond 500 lines shows `… (truncated, showing first 500 of N lines)`.
- **No output**: Shows `(no output)`.
- **Timeout**: 60 s — exceeded commands show `TIMEOUT` in red.

## Design notes

- Uses `node:child_process.exec` with `shell: true` so the command string is
  parsed naturally (same as typing it in a terminal).
- Default timeout of 60 s; max buffer 2 MB.
- The command starts immediately and the renderer shows a `$ <cmd>` status line
  so you know it's running.
- Output is never fed to the LLM — the `run()` method returns a `{ message }`
  and the TUI/REPL surfaces it as a display-only history entry.

## Code references

- `packages/cli/src/slash-commands/dev.ts` — the `/dev` command
