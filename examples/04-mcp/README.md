# 04 — MCP Integration

Examples showing MCP server configuration and usage.

## Filesystem server

```bash
# Add the built-in preset
wrongstack mcp add filesystem --enable

# Now the agent can use filesystem tools
wrongstack "list all files in the current directory using the MCP filesystem tool"
```

## GitHub server

```bash
wrongstack mcp add github --enable
# Set GITHUB_PERSONAL_ACCESS_TOKEN env var or add to config

wrongstack "list open issues on this repository"
```

## Brave Search

```bash
wrongstack mcp add brave-search --enable
# Set BRAVE_API_KEY env var

wrongstack "search for the latest Node.js 22 changelog"
```

## Custom MCP server

Add to `~/.wrongstack/config.json`:

```jsonc
{
  "mcpServers": {
    "my-server": {
      "name": "my-server",
      "transport": "stdio",
      "command": "node",
      "args": ["./my-mcp-server.js"],
      "enabled": true,
      "allowedTools": ["tool_a", "tool_b"],
      "permission": "auto"
    }
  }
}
```

## SSE transport

```jsonc
{
  "mcpServers": {
    "remote-tools": {
      "name": "remote-tools",
      "transport": "sse",
      "url": "https://mcp.example.com/sse",
      "headers": {
        "Authorization": "Bearer enc:v1:..."
      },
      "enabled": true
    }
  }
}
```

## Managing servers

```bash
wrongstack mcp                    # list all servers and states
wrongstack mcp add filesystem --enable   # add a preset
wrongstack mcp restart filesystem        # reconnect
```

In-session:

```
/mcp                              # list connected servers
```

## Permission control

MCP tools default to `confirm` (ask before each call). Override per server:

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "permission": "auto",        // auto-approve all tools
      "allowedTools": ["read_file"] // or restrict to specific tools
    }
  }
}
```

Or use trust.json for fine-grained control:

```jsonc
// ~/.wrongstack/projects/<hash>/trust.json
{
  "mcp__filesystem__read_file": {
    "allow": ["src/**"]
  }
}
```
