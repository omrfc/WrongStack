# `wstack mailbox serve` - Mailbox HTTP bridge

Runs a loopback HTTP façade over the project's shared `GlobalMailbox`, so
**external** coding agents (Claude Code, Aider, custom scripts) can read and
send messages on the same channel WrongStack-internal agents use. Every route
is a thin JSON-in/JSON-out wrapper over a `GlobalMailbox` method, so file
locking, mtime-cached reads, heartbeats, and HQ telemetry behave exactly as
they do for internal callers — external agents never get raw file access.

## Usage

| Command | Effect |
|---|---|
| `wstack mailbox serve` | Bind `127.0.0.1`, OS-assigned port |
| `wstack mailbox serve --port <n>` | Pin the port |
| `wstack mailbox serve --strict-port` | Fail (instead of falling back) if the pinned port is busy |
| `wstack mailbox serve --host <ip>` | Expose beyond loopback — NOT recommended without a re-authenticating reverse proxy |

From inside a REPL session, `/mailbox-serve` spawns this subcommand as a
detached child (see `docs/slash/mailbox-serve.md`).

## Authentication & single-instance lock

- On first start a 32-byte random bearer token is minted and persisted in the
  lock file AND `<projectDir>/.mailbox.token` (mode 0600). Restarts of the
  same instance reuse it, so external agents survive bridge restarts. Tokens
  are compared in constant time.
- Single instance per project: the lock at `<projectDir>/.mailbox-bridge.lock`
  records owner PID, URL, and token. A second `serve` for the same project
  prints the existing URL + token and exits 0 — so `$(wstack mailbox serve)`
  is idempotent in shell pipelines. A dead-PID lock is treated as stale and a
  fresh instance starts.

## Routes (all bearer-token gated)

```
POST /mailbox/send              POST /mailbox/query
POST /mailbox/check             POST /mailbox/ack
POST /mailbox/ack-many          POST /mailbox/unread-count
POST /mailbox/agents/register   POST /mailbox/agents/heartbeat
POST /mailbox/register-client   POST /mailbox/heartbeat
GET  /mailbox/agents
```

Startup prints a `mailbox_serve_started` JSON event with the bind URL, project
dir, and token path — deterministic hook for scripts.

## Code Reference

- `packages/cli/src/subcommands/handlers/mailbox-serve.ts`
- `packages/core/src/coordination/global-mailbox.ts`
- `docs/slash/mailbox-serve.md`, `docs/slash/mailbox.md`
