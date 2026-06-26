# /mcp - MCP Server Management

Manages Model Context Protocol server presets and project configuration from
inside the REPL. The slash command delegates to the same MCP management helper
used by the CLI subcommand.

## Usage

| Command | Effect |
|---|---|
| `/mcp` | List available presets and configured servers |
| `/mcp list` | Same as `/mcp` |
| `/mcp add <name>` | Add a server preset to config, disabled by default |
| `/mcp add <name> --enable` | Add a preset and enable it immediately |
| `/mcp remove <name>` | Remove a configured server |
| `/mcp enable <name>` | Enable a configured server and start it |
| `/mcp disable <name>` | Disable a configured server and stop it |
| `/mcp restart <name>` | Restart a running server in the current REPL session |

Alias: `/mcp-servers`.

## Surfaces

MCP servers can be managed from every surface, all backed by the **same**
`~/.wrongstack/config.json` → `mcpServers` and the **same** in-process
`MCPRegistry`:

- **REPL / TUI** — the `/mcp` command above (`mcp-utils.ts`).
- **WebUI** — Settings → MCP panel. Works in both `wstackui` (standalone
  server) and `wrongstack --webui` (CLI-embedded server). Add/remove/enable/
  disable/restart/discover and live status + tool names are wired to a real
  registry. SSE / streamable-http servers (e.g. `context7`) persist their `url`.
- **Engine / LLM** — the `mcp_control` / `mcp_use` tools.

The WebUI servers translate WebSocket messages over the shared management core
`packages/mcp/src/manage.ts` (`addMcp`/`enableMcp`/`listMcp`/…), so all surfaces
behave identically and cannot drift.

## Lazy connect (on-demand spawn)

A server can be marked **lazy** (`MCPServerConfig.lazy: true`, or the "Lazy
connect" checkbox in the WebUI dialog). A lazy server is **not spawned at boot**:

- Its tools are registered from a cached manifest (discovered on the first ever
  connect, stored at `~/.wrongstack/cache/mcp-tools/<server>.json`), so the model
  still sees them.
- The process spawns only when one of its tools is actually called (transparent,
  single-flight), shown as **Sleeping** (`dormant`) until then.
- After an idle window (default 5 min) with no calls, the process is stopped
  automatically and re-woken on the next call.

The first-ever connection of a brand-new lazy server does one cold discovery
connect to learn + cache its tools; every later boot is fully cold until first
use. Non-lazy servers are unchanged (eager connect at boot).

## Examples

```text
/mcp
/mcp add filesystem --enable
/mcp enable github
/mcp restart brave-search
```

## Code Reference

- `packages/cli/src/slash-commands/mcp.ts`
- `packages/cli/src/slash-commands/mcp-utils.ts`
- `packages/cli/src/subcommands/handlers/mcp.ts`
- `packages/core/src/infrastructure/mcp-servers.ts`
- `packages/mcp/src/manage.ts` — shared management core (used by both WebUI servers)
- `packages/webui/src/server/mcp-handlers.ts` — WebUI WS ↔ manage.ts translator
