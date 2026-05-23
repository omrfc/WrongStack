import type { Tool } from '@wrongstack/core';

interface ToolSearchInput {
  query?: string;
  tags?: string[];
  permission?: 'auto' | 'confirm' | 'deny';
  mutating?: boolean;
  limit?: number;
}

interface ToolSearchOutput {
  tools: {
    name: string;
    description: string;
    permission: string;
    mutating: boolean;
  }[];
  total: number;
  truncated: boolean;
}

export const toolSearchTool: Tool<ToolSearchInput, ToolSearchOutput> = {
  name: 'tool_search',
  category: 'Meta',
  description:
    'Search available tools by name, description, tags, permission level, or mutating flag.',
  usageHint:
    'Set `query` for keyword search. `tags` to filter by category. `permission` to filter by required permission. `mutating` to filter by mutating flag.',
  permission: 'auto',
  mutating: false,
  timeoutMs: 1_000,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query for tool name or description',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter by tags (e.g. "filesystem", "network", "dev")',
      },
      permission: {
        type: 'string',
        enum: ['auto', 'confirm', 'deny'],
        description: 'Filter by required permission level',
      },
      mutating: {
        type: 'boolean',
        description: 'Filter by mutating flag (true=filters that modify, false=read-only)',
      },
      limit: {
        type: 'integer',
        description: 'Maximum results to return (default: 20)',
        minimum: 1,
        maximum: 100,
      },
    },
  },
  async execute(input, ctx) {
    const limit = Math.min(input.limit ?? 20, 100);
    const tools = ctx.tools;
    const query = input.query?.toLowerCase() ?? '';

    const filtered = tools.filter((t: Tool) => {
      if (
        query &&
        !t.name.toLowerCase().includes(query) &&
        !t.description.toLowerCase().includes(query)
      ) {
        return false;
      }
      if (input.tags && input.tags.length > 0) {
        const toolCat = (t.category ?? '').toLowerCase();
        if (!input.tags.some((tag: string) => toolCat.includes(tag.toLowerCase()))) {
          return false;
        }
      }
      if (input.permission && t.permission !== input.permission) {
        return false;
      }
      if (typeof input.mutating === 'boolean' && t.mutating !== input.mutating) {
        return false;
      }
      return true;
    });

    const results = filtered.slice(0, limit).map((t: Tool) => ({
      name: t.name,
      description: t.description,
      permission: t.permission,
      mutating: t.mutating,
    }));

    return {
      tools: results,
      total: filtered.length,
      truncated: filtered.length > limit,
    };
  },
};