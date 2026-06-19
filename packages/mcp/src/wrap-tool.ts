import type { Permission, Tool } from '@wrongstack/core';
import type { MCPClient, MCPTool } from './client.js';

/**
 * Keywords that indicate a mutating operation.
 * Applied to both the tool name and its inputSchema property names.
 */
const MUTATING_RE = /create|update|delete|write|send|set|put|post|patch|remove|rename|move/i;

function isMutatingTool(mcpTool: MCPTool): boolean {
  if (MUTATING_RE.test(mcpTool.name)) return true;
  // Check property names in the input schema for mutating intent.
  // e.g. { properties: { createTable: {...}, dropIndex: {...} } }
  const schema = mcpTool.inputSchema;
  if (schema && typeof schema === 'object') {
    const props = (schema as { properties?: Record<string, unknown> }).properties;
    if (props) {
      for (const key of Object.keys(props)) {
        if (MUTATING_RE.test(key)) return true;
      }
    }
  }
  return false;
}

/**
 * Resolves the live client for a tool call. A plain {@link MCPClient} for eager
 * servers, or a thunk that connects-on-demand for lazy/dormant servers (the
 * registry passes `() => this.ensureConnected(name)`).
 */
export type MCPClientResolver = MCPClient | (() => Promise<MCPClient>);

export function wrapMCPTool(
  serverName: string,
  mcpTool: MCPTool,
  client: MCPClientResolver,
  permission: Permission = 'confirm',
): Tool {
  const qualifiedName = `mcp__${serverName}__${mcpTool.name}`;
  return {
    name: qualifiedName,
    description: mcpTool.description ?? `${qualifiedName} (MCP tool)`,
    usageHint: `Tool provided by MCP server "${serverName}". ${mcpTool.description ?? ''}`,
    permission,
    mutating: isMutatingTool(mcpTool),
    inputSchema: mcpTool.inputSchema ?? { type: 'object', properties: {} },
    async execute(input, _ctx, _opts) {
      // For a dormant lazy server this spawns the process + handshakes before
      // the first call; for an eager server it resolves to the fixed client.
      const live = typeof client === 'function' ? await client() : client;
      const res = await live.callTool(mcpTool.name, input);
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
          const t = (item as { type?: string | undefined; text?: string | undefined }).type;
          if (t === 'text') return (item as { text?: string | undefined }).text ?? '';
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
