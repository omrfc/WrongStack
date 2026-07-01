# /working_dir — Show or change the working directory

Shows or changes the directory the agent's relative paths and commands
resolve against — without restarting the session.

Aliases: `/wd`, `/cd`.

## Usage

| Command | Effect |
|---|---|
| `/working_dir` | Show the current working directory, its path relative to the project root, and the project root. |
| `/working_dir <path>` | Change the working directory to `<path>`. |
| `/working_dir .` | Reset back to the project root. |

## Rules

- The target must be **inside the project root** — attempts to escape it are
  rejected with the resolved path shown.
- Relative paths resolve from the **project root**, not from the current
  working directory (by convention, so `/wd packages/core` always means the
  same thing).
- The directory must already exist; the command never creates it.

## Effects of a change

`ctx.setWorkingDir()` updates the live context, so subsequent tool calls
(bash, read, glob, …) resolve against the new directory. The change
propagates to the statusline and to connected WebUI clients over WebSocket.

## Examples

```
/wd                     → Working directory: D:\proj  (relative to root: .)
/wd packages/core       → ✓ . → packages/core
/cd .                   → back to the project root
```

See also: `/project` (switch to a different project entirely).
