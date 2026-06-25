import { WrongStackError, ERROR_CODES } from '../types/errors.js';
import type { ToolDescriptionMode, ToolDescriptionModeConfig } from '../types/config.js';
import type { Tool } from '../types/tool.js';
import {
  applyToolDescriptionModeToTool,
  normalizeToolDescriptionMode,
} from '../utils/tool-description-mode.js';
import { estimateToolDefTokens } from '../utils/token-estimate.js';

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
  private readonly descriptionModes = new Map<string, ToolDescriptionMode>();
  /** Monotonic version bumped on every registry mutation. */
  private _version = 0;
  /** Cached `list()` result, frozen after build. Invalidated on _version change. */
  private _listSnapshot: readonly Tool[] | undefined;
  private _listSnapshotVersion = -1;

  /** Pre-compute tool definition token estimate once at registration time. */
  private _stampDefTokens(tool: Tool): void {
    if (tool._estDefTokens === undefined) {
      tool._estDefTokens = estimateToolDefTokens(tool);
    }
  }

  private _prepareForStorage(tool: Tool): Tool {
    const mode = this.descriptionModes.get(tool.name) ?? 'extend';
    return applyToolDescriptionModeToTool(tool, mode);
  }

  register(tool: Tool, owner = 'core'): void {
    if (this.tools.has(tool.name)) {
      throw new WrongStackError({
        message: `Tool "${tool.name}" already registered`,
        code: ERROR_CODES.REGISTRY_DUPLICATE,
        subsystem: 'container',
        context: { tool: tool.name },
      });
    }

    // Registration-time guarantee: Every tool must have a usable inputSchema.
    // This prevents tools with broken or missing schemas from ever being registered.
    if (!tool.inputSchema || typeof tool.inputSchema !== 'object') {
      throw new WrongStackError({
        message: `Tool "${tool.name}" has an invalid or missing inputSchema`,
        code: ERROR_CODES.REGISTRY_INVALID,
        subsystem: 'container',
        context: { tool: tool.name },
      });
    }

    const stored = this._prepareForStorage(tool);
    this._stampDefTokens(stored);
    this.tools.set(tool.name, { tool: stored, owner });
    this._version++;
  }

  /**
   * Attempt to register a tool. Returns true if successful, false if a tool
   * with the same name is already registered. Useful in multi-agent or plugin
   * scenarios where duplicate registration may be intentional.
   */
  tryRegister(tool: Tool, owner = 'core'): boolean {
    if (this.tools.has(tool.name)) return false;

    if (!tool.inputSchema || typeof tool.inputSchema !== 'object') {
      return false; // silently reject invalid schema in tryRegister
    }

    const stored = this._prepareForStorage(tool);
    this._stampDefTokens(stored);
    this.tools.set(tool.name, { tool: stored, owner });
    this._version++;
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
    const stored = this._prepareForStorage(tool);
    this._stampDefTokens(stored);
    this.tools.set(tool.name, { tool: stored, owner });
    this._version++;
  }

  unregister(name: string): boolean {
    const deleted = this.tools.delete(name);
    if (deleted) this._version++;
    return deleted;
  }

  /**
   * Override an existing tool. Throws if the tool is not already registered.
   * Plugins use this to replace built-in tools with custom implementations.
   */
  override(name: string, tool: Tool, owner = 'core'): void {
    if (!this.tools.has(name)) {
      throw new WrongStackError({
        message: `Tool "${name}" not registered; cannot override`,
        code: ERROR_CODES.REGISTRY_NOT_FOUND,
        subsystem: 'container',
        context: { tool: name },
      });
    }
    const stored = this._prepareForStorage(tool);
    this._stampDefTokens(stored);
    this.tools.set(name, { tool: stored, owner });
    this._version++;
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
        code: ERROR_CODES.REGISTRY_NOT_FOUND,
        subsystem: 'container',
        context: { tool: name },
      });
    }
    const current = applyToolDescriptionModeToTool(entry.tool, 'extend');
    const wrapped = this._prepareForStorage(wrapper(current));
    // The wrapper may have changed name/description/inputSchema — recompute.
    wrapped._estDefTokens = undefined;
    this._stampDefTokens(wrapped);
    this.tools.set(name, { tool: wrapped, owner: `${entry.owner}+${owner}` });
    this._version++;
  }

  setDescriptionMode(name: string, mode: ToolDescriptionMode): boolean {
    const normalized = normalizeToolDescriptionMode(mode);
    if (!normalized) return false;
    const entry = this.tools.get(name);
    if (!entry) return false;

    if (normalized === 'extend') {
      this.descriptionModes.delete(name);
    } else {
      this.descriptionModes.set(name, normalized);
    }

    const stored = applyToolDescriptionModeToTool(entry.tool, normalized);
    stored._estDefTokens = undefined;
    this._stampDefTokens(stored);
    this.tools.set(name, { ...entry, tool: stored });
    this._version++;
    return true;
  }

  getDescriptionMode(name: string): ToolDescriptionMode {
    return this.descriptionModes.get(name) ?? 'extend';
  }

  applyDescriptionModes(
    modes: ToolDescriptionModeConfig = {},
  ): { applied: number; missing: string[] } {
    const missing: string[] = [];
    let applied = 0;
    for (const [name, rawMode] of Object.entries(modes)) {
      const mode = normalizeToolDescriptionMode(rawMode);
      if (!mode) continue;
      if (this.tools.has(name)) {
        if (this.setDescriptionMode(name, mode)) applied++;
      } else {
        if (mode === 'simple') this.descriptionModes.set(name, mode);
        else this.descriptionModes.delete(name);
        missing.push(name);
      }
    }
    return { applied, missing };
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)?.tool;
  }

  ownerOf(name: string): string | undefined {
    return this.tools.get(name)?.owner;
  }

  list(): Tool[] {
    if (this._listSnapshot && this._version === this._listSnapshotVersion) {
      return this._listSnapshot as Tool[];
    }
    const arr = Array.from(this.tools.values()).map((e) => e.tool);
    this._listSnapshot = arr;
    this._listSnapshotVersion = this._version;
    return arr;
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
    this.descriptionModes.clear();
    this._version++;
  }

  /**
   * Return a new ToolRegistry with the same registered tools and owners.
   * Useful for creating filtered copies in multi-agent scenarios.
   */
  clone(): ToolRegistry {
    const copy = new ToolRegistry();
    for (const [name, mode] of this.descriptionModes) {
      copy.descriptionModes.set(name, mode);
    }
    for (const { tool, owner } of this.listWithOwner()) copy.register(tool, owner);
    return copy;
  }
}
