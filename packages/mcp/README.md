# MCP Servers — WrongStack

Connect any [Model Context Protocol](https://modelcontextprotocol.io) server to WrongStack and use its tools as if they were built-in.

## Supported Transports

| Transport | Description |
|-----------|-------------|
| `stdio` | Spawns a local binary; communicates over stdin/stdout |
| `sse` | HTTP Server-Sent Events for server events; HTTP POST for requests |
| `streamable-http` | Session-based HTTP with NDJSON responses |

## Quick Start

```json
// ~/.wrongstack/config.json
{
  "mcpServers": {
    "filesystem": {
      "enabled": true
    }
  }
}
```

Then run `wstack` — the filesystem server is now active with tools like `mcp__filesystem__read_file`, `mcp__filesystem__write_file`, etc.

## Built-in Server Presets

WrongStack bundles configs for popular MCP servers. Enable them with:

```bash
# Add a server (disabled by default)
wstack mcp add filesystem

# Add and enable immediately
wstack mcp add github --enable
wstack mcp add minimax-vision --enable

# List configured servers
wstack mcp list
```

### Available Presets

| Name | Transport | Description | Requires |
|------|-----------|-------------|----------|
| `filesystem` | stdio | Read, write, list, and search local files | — |
| `github` | stdio | Issues, PRs, repos, search, file operations | `GITHUB_PERSONAL_ACCESS_TOKEN` |
| `context7` | streamable-http | Codebase-aware documentation and Q&A | — |
| `brave-search` | stdio | Web search | `BRAVE_SEARCH_API_KEY` (free 2k/month) |
| `block` | stdio | Postgres via SQL | — |
| `everart` | stdio | AI image generation | `EVERART_API_KEY` |
| `slack` | stdio | Messaging, channels, search | `SLACK_BOT_TOKEN` + `SLACK_TEAM_ID` |
| `aws` | stdio | EC2, S3, Lambda, IAM, CloudFormation | AWS credentials |
| `google-maps` | stdio | Directions, geocoding, places | `GOOGLE_MAPS_API_KEY` |
| `sentinel` | streamable-http | Security vulnerability scanning | — |
| `zai-vision` | stdio | Image and screenshot understanding for text-only models | `Z_AI_API_KEY` |
| `minimax-vision` | stdio | MiniMax `understand_image` adapter for text-only models | `MINIMAX_API_KEY`, `uvx` |

## Manual Configuration

```json
{
  "mcpServers": {
    "my-server": {
      "name": "my-server",
      "description": "My custom MCP server",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@my-org/mcp-server", "--verbose"],
      "enabled": true,
      "permission": "confirm",
      "allowedTools": ["read", "search"],
      "startupTimeoutMs": 10000,
      "requestTimeoutMs": 60000
    }
  }
}
```

### Configuration Reference

```typescript
interface MCPServerConfig {
  name: string;
  transport: 'stdio' | 'sse' | 'streamable-http';

  // stdio — local binary
  command?: string;    // e.g. "npx", "/usr/local/bin/my-mcp-server"
  args?: string[];
  env?: Record<string, string>;

  // sse / streamable-http — remote
  url?: string;
  headers?: Record<string, string>;

  // Common options
  enabled?: boolean;          // default: true
  allowedTools?: string[];    // whitelist — undefined = all tools
  permission?: Permission;    // 'auto' | 'confirm' | 'deny'  (default: 'confirm')
  startupTimeoutMs?: number;  // default: 10000
  requestTimeoutMs?: number;  // default: 60000
  description?: string;        // shown in `wstack mcp list`
}
```

## MCP Tool Naming

All MCP tools are prefixed with `mcp__<server-name>__` to prevent collision:

```
mcp__github__list_issues
mcp__github__create_pull_request
mcp__filesystem__read_file
mcp__filesystem__write_file
```

This means you can have a built-in `read_file` tool AND `mcp__filesystem__read_file` without conflict.

## Permission Model

All MCP tools default to `permission: 'confirm'` regardless of whether they look read-only. This means the agent asks before using them. You can:

1. **Trust a server** — set `permission: 'auto'` in the server config (all tools run without asking)
2. **Trust specific tools** — use a trust policy config (see `Config` type):
   ```json
   { "mcp__github__*": { "auto": true } }
   ```
3. **Deny a server** — set `permission: 'deny'` (tools exist but agent must explicitly request confirmation)

## Reconnection

- **stdio servers**: If the child process exits, WrongStack automatically retries up to 3 times with exponential backoff (500ms → 1s → 2s). After 3 failures the server is marked `failed` and tools are unregistered.
- **HTTP servers (SSE / streamable-http)**: If the SSE read loop errors, the transport transitions to `disconnected` and the registry schedules a reconnect.

## Troubleshooting

### Server fails to start

Check that:
- The `command` is in your `PATH` (or use an absolute path)
- `npx -y @modelcontextprotocol/server-filesystem .` works standalone
- The `startupTimeoutMs` is sufficient for slow-starting servers
- The `requestTimeoutMs` is sufficient for long-running tool calls

### Tools not appearing

```bash
wstack mcp list          # shows configured servers + state
wstack diag              # shows MCP health under "MCP Servers:"
```

### Connection drops repeatedly

This usually means the server process crashes on startup. Try running it manually:
```bash
node /path/to/server/script.js
# then type: {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
```

### `allowedTools` not filtering

Restart after changing `allowedTools` — the tool list is cached after discovery.

## Writing Your Own MCP Server

Any server that implements the [MCP spec](https://spec.modelcontextprotocol.io) works with WrongStack. Minimal example:

```typescript
// server.js — stdio MCP server
import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  const req = JSON.parse(line);
  if (req.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: req.id,
      result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'my-server', version: '1.0.0' } }
    }) + '\n');
    process.stdout.flush();
  } else if (req.method === 'tools/list') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: req.id,
      result: { tools: [{ name: 'greet', description: 'Say hello', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } }] }
    }) + '\n');
    process.stdout.flush();
  }
});
```

Then in your config:
```json
{
  "mcpServers": {
    "my-server": {
      "transport": "stdio",
      "command": "node",
      "args": ["/path/to/server.js"]
    }
  }
}
```
