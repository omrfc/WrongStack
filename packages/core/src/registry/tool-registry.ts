import { WrongStackError } from '../types/errors.js';
import type { Tool } from '../types/tool.js';

/**
 * A function that wraps (decorates) an existing tool. Receives the
 * original tool and returns a modified version — typically the same
 * tool with a wrapped `execute` / `executeStream`, or with modified
 * metadata (description, permission).
 *
 * Use `ToolRegistry.wrap()` to apply; the wrapper is called immediately
 * and the result replaces the registered tool. Multiple wraps stack —
 * each wrapper receives the output of the previous.
 *
 * @example
 * ```ts
 * registry.wrap('read', (original) => ({
 *   ...original,
 *   async execute(input, ctx, opts) {
 *     console.log('read called');
 *     return original.execute(input, ctx, opts);
 *   }
 * }));
 * ```
 */
export type ToolWrapper = (tool: Tool) => Tool;

export class ToolRegistry {
  private readonly tools = new Map<string, { tool: Tool; owner: string }>();

  register(tool: Tool, owner = 'core'): void {
    if (this.tools.has(tool.name)) {
      throw new WrongStackError({
        message: `Tool "${tool.name}" already registered`,
        code: 'REGISTRY_DUPLICATE',
        subsystem: 'container',
        context: { tool: tool.name },
      });
    }
    this.tools.set(tool.name, { tool, owner });
  }

  /**
   * Attempt to register a tool. Returns true if successful, false if a tool
   * with the same name is already registered. Useful in multi-agent or plugin
   * scenarios where duplicate registration may be intentional.
   */
  tryRegister(tool: Tool, owner = 'core'): boolean {
    if (this.tools.has(tool.name)) return false;
    this.tools.set(tool.name, { tool, owner });
    return true;
  }

  /**
   * Bulk-register multiple tools at once. Each tool that conflicts with an
   * existing registration is silently skipped — use `registerAllOrThrow`
   * if you want it to throw on conflicts.
   */
  registerAll(tools: Tool[], owner = 'core'): void {
    for (const tool of tools) this.tryRegister(tool, owner);
  }

  /**
   * Bulk-register and throw on the first conflict. Use when you need
   * strict registration (e.g. at boot time).
   */
  registerAllOrThrow(tools: Tool[], owner = 'core'): void {
    for (const tool of tools) this.register(tool, owner);
  }

  /**
   * Register a tool as a default. If the tool name is already registered,
   * this is a no-op — the existing registration (from core or another
   * plugin) takes precedence. Use `override` to intentionally replace.
   */
  registerDefault(tool: Tool, owner = 'core'): void {
    if (this.tools.has(tool.name)) return;
    this.tools.set(tool.name, { tool, owner });
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Override an existing tool. Throws if the tool is not already registered.
   * Plugins use this to replace built-in tools with custom implementations.
   */
  override(name: string, tool: Tool, owner = 'core'): void {
    if (!this.tools.has(name)) {
      throw new WrongStackError({
        message: `Tool "${name}" not registered; cannot override`,
        code: 'REGISTRY_NOT_FOUND',
        subsystem: 'container',
        context: { tool: name },
      });
    }
    this.tools.set(name, { tool, owner });
  }

  /**
   * Wrap (decorate) an existing tool. The wrapper receives the current
   * tool and must return a new tool — typically the same tool with a
   * wrapped `execute` or `executeStream`. Throws if the tool is not
   * registered.
   *
   * Multiple wraps stack: each wrapper gets the output of the previous.
   *
   * @example
   * registry.wrap('bash', (t) => ({ ...t, permission: 'confirm' }));
   */
  wrap(name: string, wrapper: ToolWrapper, owner = 'core'): void {
    const entry = this.tools.get(name);
    if (!entry) {
      throw new WrongStackError({
        message: `Tool "${name}" not registered; cannot wrap`,
        code: 'REGISTRY_NOT_FOUND',
        subsystem: 'container',
        context: { tool: name },
      });
    }
    const wrapped = wrapper(entry.tool);
    this.tools.set(name, { tool: wrapped, owner: `${entry.owner}+${owner}` });
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)?.tool;
  }

  ownerOf(name: string): string | undefined {
    return this.tools.get(name)?.owner;
  }

  list(): Tool[] {
    return Array.from(this.tools.values()).map((e) => e.tool);
  }

  /**
   * Group tools by their `category` field. Tools without a category
   * are placed under the key `""` (empty string). Returns a Map of
   * category → tools, sorted by registration order within each category.
   */
  listByCategory(): Map<string, Tool[]> {
    const map = new Map<string, Tool[]>();
    for (const { tool } of this.tools.values()) {
      const cat = tool.category ?? '';
      let group = map.get(cat);
      if (!group) {
        group = [];
        map.set(cat, group);
      }
      group.push(tool);
    }
    return map;
  }

  listWithOwner(): { tool: Tool; owner: string }[] {
    return Array.from(this.tools.values());
  }

  clear(): void {
    this.tools.clear();
  }

  /**
   * Return a new ToolRegistry with the same registered tools and owners.
   * Useful for creating filtered copies in multi-agent scenarios.
   */
  clone(): ToolRegistry {
    const copy = new ToolRegistry();
    for (const { tool, owner } of this.listWithOwner()) copy.register(tool, owner);
    return copy;
  }
}
