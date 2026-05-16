import { WrongStackError } from '../types/errors.js';
import type { Tool } from '../types/tool.js';

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

  get(name: string): Tool | undefined {
    return this.tools.get(name)?.tool;
  }

  ownerOf(name: string): string | undefined {
    return this.tools.get(name)?.owner;
  }

  list(): Tool[] {
    return Array.from(this.tools.values()).map((e) => e.tool);
  }

  listWithOwner(): { tool: Tool; owner: string }[] {
    return Array.from(this.tools.values());
  }

  clear(): void {
    this.tools.clear();
  }
}
