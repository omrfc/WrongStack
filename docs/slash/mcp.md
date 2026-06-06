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
