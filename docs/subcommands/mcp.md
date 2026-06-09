# `wstack mcp` and `/mcp` — MCP Server Lifecycle

## What it does

Manages MCP server configurations in `config.json` and their runtime lifecycle.
There are two interfaces:

| Interface | Environment | Add/Remove/Enable/Disable | Restart |
|---|---|---|---|
| `wstack mcp` | CLI + REPL | ✅ writes to config | ⚠️ warns "REPL only" |
| `/mcp` | REPL + TUI | ✅ writes to config + runtime | ✅ runtime restart |

Servers are started automatically when WrongStack boots (REPL/TUI mode).

## CLI subcommands (`wstack mcp`)

| Usage | Effect |
|---|---|
| `wstack mcp` | List all configured servers |
| `wstack mcp list` | Same |
| `wstack mcp add <name>` | Add server preset to config (disabled by default) |
| `wstack mcp add <name> --enable` | Add and immediately enable |
| `wstack mcp remove <name>` | Remove a server from config |

## Slash commands (`/mcp`) — REPL/TUI only

| Usage | Effect |
|---|---|
| `/mcp` | List available and configured servers |
| `/mcp list` | Same |
| `/mcp add <name>` | Add server preset to config (disabled) |
| `/mcp add <name> --enable` | Add and immediately enable + start |
| `/mcp remove <name>` | Remove server from config + stop |
| `/mcp enable <name>` | Enable in config + start (runtime) |
| `/mcp disable <name>` | Disable in config + stop (runtime) |
| `/mcp restart <name>` | Stop and restart a running server |

## Config format

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "enabled": true,
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "github": {
      "enabled": true,
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    },
    "context7": {
      "enabled": false,
      "transport": "streamable-http",
      "url": "https://server.context7.ai/mcp"
    }
  }
}
```

## Transport types

| Transport | Config needed | Notes |
|---|---|---|
| `stdio` | `command` (required), `args`, `env` | Child process via stdin/stdout |
| `sse` | `url` (required) | Server-sent events |
| `streamable-http` | `url` (required) | NDJSON over HTTP |

## Built-in server presets

All presets are available via `allServers()` and can be added with either
`wstack mcp add <name>` or `/mcp add <name>`:

| Name | Description | Permission |
|---|---|---|
| `filesystem` | Read/write/navigate local filesystem | `confirm` |
| `github` | GitHub API — issues, PRs, repos, search | `confirm` |
| `context7` | Codebase-aware documentation (context7.ai) | `confirm` |
| `brave-search` | Web search (requires `BRAVE_SEARCH_API_KEY`) | `confirm` |
| `block` | Postgres database access via SQL | `confirm` |
| `everart` | AI image generation (requires `EVERART_API_KEY`) | `confirm` |
| `slack` | Slack messaging, channels, search | `confirm` |
| `aws` | AWS — EC2, S3, Lambda, IAM, CloudFormation | `confirm` |
| `google-maps` | Directions, geocoding, places | `confirm` |
| `sentinel` | Security vulnerability scanning | `deny` |
| `zai-vision` | Image analysis and screenshot understanding | `auto` |
| `minimax-vision` | MiniMax image understanding (read-only) | `auto` |
| `playwright` | Browser automation — navigate, screenshot, click, type, evaluate JS | `confirm` |

### Playwright + Browser Agent

The Playwright MCP server pairs with the **browser** roster agent for isolated
browser tasks. Instead of cluttering the main agent's context with
screenshots and page HTML, delegate browser work to a dedicated subagent:

```bash
# 1. Start the Playwright MCP server
/mcp enable playwright

# 2. Delegate to the browser agent (lightweight: no bash/write)
/delegate browser "Open https://example.com, take a screenshot, extract the page title"

# 3. (Optional) Stop Playwright when done
/mcp disable playwright
```

The **browser** agent is read-focused — it has Playwright tools + `read`/`grep`
+/`glob` but no `bash`, `exec`, `write`, or `edit`. For full end-to-end test
flows that need the build toolchain, use the **e2e** agent instead:
`/delegate e2e "test the login flow at https://... including backend assertions"`.

| Agent | Tools | Best for |
|---|---|---|
| `browser` | Playwright + read/grep/glob/fetch | Quick browser tasks: screenshot, scrape, form fill |
| `e2e` | Playwright + full build (bash, exec, test, …) | Full end-to-end scenarios across UI + API + CLI |

## Connection states

```
idle → connecting → connected
                  ↘ reconnecting ↗
                  ↘ disconnected ↗  (auto-reconnect)
                  ↘ failed         (exhausted reconnect budget)
```

| State | Meaning |
|---|---|
| `idle` | Not yet started |
| `connecting` | First connection attempt |
| `connected` | Healthy, tools available |
| `reconnecting` | Connection lost, retry in progress |
| `disconnected` | Stopped or not started |
| `failed` | Reconnect budget exhausted |

## Reconnect behavior

When a server disconnects (child exit, HTTP transport flap), the registry
schedules exponential-backoff reconnect cycles:

- **Max cycles:** 5 before the slot goes `failed` and needs manual `/mcp restart`
- **Base delay:** 1 s, 2 s, 4 s, 8 s, 16 s (capped at 30 s)
- **Jitter:** ±20% to avoid reconnect stampedes
- **Attempts per cycle:** up to 3

A successful connect resets the cycle counter — future crashes get the full budget.

## Per-server tool filtering

Use `allowedTools` in config to expose only a subset of a server's tools:

```jsonc
{
  "mcpServers": {
    "github": {
      "enabled": true,
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "allowedTools": ["createIssue", "listIssues"]
    }
  }
}
```

## TLS configuration (HTTP transports)

For HTTPS servers with custom certificates:

```jsonc
{
  "mcpServers": {
    "context7": {
      "enabled": false,
      "transport": "streamable-http",
      "url": "https://server.context7.ai/mcp",
      "tls": {
        "ca": "/path/to/ca.pem",
        "rejectUnauthorized": false
      }
    }
  }
}
```

## SSRF protection

MCP HTTP transports validate URLs to block internal/cloud-metadata targets:

- `localhost`, `0.0.0.0`, `::`, `[::1]` — allowed (local servers)
- `169.254.x.x` (IMDS / link-local) — blocked
- Other RFC1918 ranges — allowed (LAN MCP servers are legitimate)

## Graceful child shutdown

When closing a stdio transport, WrongStack sends SIGTERM first (800 ms
grace period), then SIGKILL if the server doesn't exit (Windows-safe via
`TerminateProcess`).

## Code reference

- `packages/cli/src/subcommands/handlers/mcp.ts` — CLI subcommand handler
- `packages/cli/src/slash-commands/mcp.ts` — `/mcp` slash command
- `packages/cli/src/slash-commands/mcp-utils.ts` — shared management logic
- `packages/mcp/src/client.ts` — `MCPClient`
- `packages/mcp/src/registry.ts` — `MCPRegistry` (start/stop/restart API)
- `packages/mcp/src/transport.ts` — `SSETransport`, `StreamableHTTPTransport`
- `docs/plugin-management.md`