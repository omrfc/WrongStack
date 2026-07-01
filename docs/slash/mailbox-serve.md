# /mailbox-serve — Start the mailbox HTTP bridge

Starts the project mailbox's HTTP bridge from inside the REPL, so
**external** agents (Claude Code, Aider, custom scripts) can read and send
messages on the same project mailbox your wstack sessions use.

The slash command is a thin wrapper: it spawns `wstack mailbox serve` as a
background child and confirms the spawn. The subcommand is the single source
of truth for auth, routes, and shutdown semantics.

## Usage

| Command | Effect |
|---|---|
| `/mailbox-serve` | Bind `127.0.0.1` on an OS-assigned port. |
| `/mailbox-serve --host <ip>` | Bind a specific host (e.g. `0.0.0.0` to expose on LAN). |
| `/mailbox-serve --port <n>` | Pin the port. |
| `/mailbox-serve --strict-port` | Fail instead of falling back when the pinned port is busy. |

## Output

The command prints the child PID, project dir, **token file path**
(`<projectDir>/.mailbox.token`, mode 0600 — hand this to the external
agent), and a PID file under the OS temp dir. It then waits up to 3 s for the
bridge's startup banner (`mailbox_serve_started`) and echoes it, including
the actual bind URL.

## Lifecycle

The bridge **outlives the REPL** — it keeps running until you stop it:

```
kill $(cat <pidfile>)     # PID file path is printed on spawn
```

On POSIX the child detaches into its own process group; on Windows it stays
attached (no visible console window) but still survives parent exit.

## Examples

```
/mailbox-serve
/mailbox-serve --port 9000 --strict-port
/mailbox-serve --host 0.0.0.0 --port 9000
```

See also: `/mailbox` (operator mailbox commands), `/mailbox-demo` (delivery
test harness), `wstack mailbox serve` (the underlying subcommand).
