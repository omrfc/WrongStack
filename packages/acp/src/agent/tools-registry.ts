/**
 * Tools registry for ACP agent-side.
 *
 * Translates WrongStack Tool definitions → ACP ACPToolDefinition format.
 * Provides tool lookup and result assembly for the ACP protocol handler.
 */
import type {Tool} from '@wrongstack/core';
import type {
  ACPToolDefinition,
  ACPToolList,
  ACPInputSchema,
  ACPToolResult,
  ContentBlock,
} from '../types/acp-messages.js';

const WRONGSTACK_CAPABILITIES = [
  'code-generation',
  'async-tools',
  'streaming',
  'progress',
];

export class ACPToolsRegistry {
  private tools = new Map<string, Tool>();
  private readonly owner: string;

  constructor(owner = 'wrongstack') {
    this.owner = owner;
  }

  /**
   * Register one or more tools.
   * Throws on duplicate name unless force=true.
   */
  register(tools: Tool[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  /**
   * Replace the current tool set.
   */
  setTools(tools: Tool[]): void {
    this.tools.clear();
    for (const tool of tools) this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  /** Build the ACP tools/list payload from registered tools. */
  buildToolList(): ACPToolList {
    return {
      tools: Array.from(this.tools.values()).map((t) =>
        toACPToolDefinition(t, this.owner),
      ),
    };
  }

  /**
   * Execute a tool by name and return ACP-formatted result.
   * Returns null if the tool is not found.
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: unknown,
    signal: AbortSignal,
  ): Promise<ACPToolResult | null> {
    const tool = this.tools.get(name);
    if (!tool) return null;

    try {
      const result = await tool.execute(args, ctx as Parameters<Tool['execute']>[1], {
        signal,
      });
      return toACPToolResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {content: [{type: 'text', text: msg}], isError: true} satisfies ACPToolResult;
    }
  }
}

/** Convert a WrongStack Tool → ACP ACPToolDefinition */
function toACPToolDefinition(tool: Tool, owner: string): ACPToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: toACPInputSchema(tool.inputSchema),
    annotations: {
      title: tool.name,
      description: tool.usageHint ?? tool.description,
      priority: toolToPriority(tool),
      alwaysAccept: tool.permission === 'auto',
    },
  };
}

/** Minimal JSON Schema → ACP input schema. ACP uses JSON Schema draft-07. */
function toACPInputSchema(src: unknown): ACPInputSchema {
  if (!src || typeof src !== 'object') {
    return {};
  }
  const s = src as Record<string, unknown>;

  // Recursively convert properties
  if (s.properties && typeof s.properties === 'object') {
    const props: Record<string, ACPInputSchema> = {};
    for (const [k, v] of Object.entries(s.properties as Record<string, unknown>)) {
      props[k] = toACPInputSchema(v);
    }
    return {
      type: typeof s.type === 'string' ? s.type : undefined,
      properties: props,
      required: Array.isArray(s.required) ? (s.required as string[]) : undefined,
      items: s.items ? toACPInputSchema(s.items) : undefined,
      enum: Array.isArray(s.enum) ? s.enum : undefined,
      description: typeof s.description === 'string' ? s.description : undefined,
      default: s.default,
      minimum: typeof s.minimum === 'number' ? s.minimum : undefined,
      maximum: typeof s.maximum === 'number' ? s.maximum : undefined,
    };
  }

  return {
    type: typeof s.type === 'string' ? s.type : undefined,
    items: s.items ? toACPInputSchema(s.items) : undefined,
    enum: Array.isArray(s.enum) ? s.enum : undefined,
    description: typeof s.description === 'string' ? s.description : undefined,
    default: s.default,
    minimum: typeof s.minimum === 'number' ? s.minimum : undefined,
    maximum: typeof s.maximum === 'number' ? s.maximum : undefined,
  };
}

/** Convert a WrongStack ToolResult → ACP ContentBlock[] */
function toACPToolResult(result: unknown): ACPToolResult {
  const blocks: ContentBlock[] = [];

  if (result === undefined || result === null) {
    return {content: [{type: 'text', text: 'ok'}]};
  }

  if (typeof result === 'string') {
    blocks.push({type: 'text', text: result});
  } else if (typeof result === 'object') {
    blocks.push({type: 'text', text: JSON.stringify(result, null, 2)});
  } else {
    blocks.push({type: 'text', text: String(result)});
  }

  return {content: blocks};
}

function toolToPriority(tool: Tool): 'high' | 'medium' | 'low' {
  if (tool.riskTier === 'destructive') return 'high';
  if (tool.riskTier === 'standard' || tool.permission === 'confirm') return 'medium';
  return 'low';
}
