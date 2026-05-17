import type { MCPTool } from './client.js';

export function normalizeMCPTools(value: unknown): MCPTool[] {
  if (!Array.isArray(value)) return [];
  const tools: MCPTool[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as { name?: unknown; description?: unknown; inputSchema?: unknown };
    if (typeof t.name !== 'string' || t.name.trim().length === 0) continue;
    const inputSchema =
      t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema)
        ? (t.inputSchema as Record<string, unknown>)
        : { type: 'object', properties: {} };
    tools.push({
      name: t.name,
      ...(typeof t.description === 'string' ? { description: t.description } : {}),
      inputSchema,
    });
  }
  return tools;
}
