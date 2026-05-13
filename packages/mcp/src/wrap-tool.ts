import type { Tool, Permission } from '@wrongstack/core';
import type { MCPClient, MCPTool } from './client.js';

const MUTATING_RE = /create|update|delete|write|send|set|put|post|patch|remove|rename|move/i;

export function wrapMCPTool(
  serverName: string,
  mcpTool: MCPTool,
  client: MCPClient,
  permission: Permission = 'confirm',
): Tool {
  const qualifiedName = `mcp__${serverName}__${mcpTool.name}`;
  return {
    name: qualifiedName,
    description: mcpTool.description ?? `${qualifiedName} (MCP tool)`,
    usageHint: `Tool provided by MCP server "${serverName}". ${mcpTool.description ?? ''}`,
    permission,
    mutating: MUTATING_RE.test(mcpTool.name),
    inputSchema: mcpTool.inputSchema ?? { type: 'object', properties: {} },
    async execute(input, ctx, opts) {
      const res = await client.callTool(mcpTool.name, input);
      if (res.isError) {
        throw new Error(stringify(res.content));
      }
      return stringify(res.content);
    },
  };
}

function stringify(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((item) => {
        if (item && typeof item === 'object') {
          const t = (item as { type?: string; text?: string }).type;
          if (t === 'text') return (item as { text?: string }).text ?? '';
          return JSON.stringify(item);
        }
        return String(item);
      })
      .join('\n');
  }
  if (c && typeof c === 'object') {
    if ('text' in (c as Record<string, unknown>)) {
      return String((c as Record<string, unknown>).text);
    }
    return JSON.stringify(c);
  }
  return String(c ?? '');
}
