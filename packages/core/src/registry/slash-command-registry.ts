import type { Context } from '../core/context.js';
import type { SlashCommand } from '../types/slash-command.js';

/**
 * A slash command registered with the CLI or available to plugins.
 * Plugins receive a view of the registry via PluginAPI.slashCommands.
 *
 * Commands registered by plugins use a namespaced name: `pluginName:commandName`.
 * This prevents collisions with built-in commands and other plugins.
 */
export { SlashCommand };

export class SlashCommandRegistry {
  private readonly cmds = new Map<string, { cmd: SlashCommand; owner: string }>();

  /**
   * Register a command. For plugins the `owner` is the plugin name and the
   * registry auto-prefixes the command name as `owner:name` to prevent
   * collisions with built-in commands and other plugins.
   */
  register(cmd: SlashCommand, owner = 'core'): void {
    const isPlugin = owner !== 'core';
    const fullName = isPlugin ? `${owner}:${cmd.name}` : cmd.name;

    // Cross-owner collision on the bare name: even though plugin commands
    // get namespaced (`plugin:x`) and don't share a key with a builtin
    // `x`, allowing both to coexist would confuse users (they type `/x`
    // expecting one and get the other). Throw so the conflict surfaces
    // at registration time rather than as a silent shadowing bug.
    for (const entry of this.cmds.values()) {
      if (entry.cmd.name === cmd.name && entry.owner !== owner) {
        throw new Error(
          `Slash command "${cmd.name}" already registered by ${entry.owner}`,
        );
      }
    }

    if (this.cmds.has(fullName)) {
      // Same owner re-registering: plugins legitimately do this for hot
      // reload / dev iteration. Built-ins are added once at startup, so
      // a second core register signals a programming bug — throw loudly.
      if (!isPlugin) {
        throw new Error(`Built-in slash command "${fullName}" is already registered.`);
      }
      this.cmds.set(fullName, { cmd, owner });
      for (const a of cmd.aliases ?? []) {
        this.cmds.set(`${owner}:${a}`, { cmd, owner });
      }
      return;
    }

    this.cmds.set(fullName, { cmd, owner });
    for (const a of cmd.aliases ?? []) {
      this.cmds.set(isPlugin ? `${owner}:${a}` : a, { cmd, owner });
    }
  }

  unregister(name: string): boolean {
    const entry = this.cmds.get(name);
    if (!entry) return false;
    for (const a of entry.cmd.aliases ?? []) {
      const fullAlias = entry.owner !== 'core' ? `${entry.owner}:${a}` : a;
      this.cmds.delete(fullAlias);
    }
    return this.cmds.delete(name);
  }

  get(name: string): SlashCommand | undefined {
    return this.cmds.get(name)?.cmd;
  }

  ownerOf(name: string): string | undefined {
    return this.cmds.get(name)?.owner;
  }

  list(): SlashCommand[] {
    const seen = new Set<SlashCommand>();
    const out: SlashCommand[] = [];
    for (const { cmd } of this.cmds.values()) {
      if (!seen.has(cmd)) {
        seen.add(cmd);
        out.push(cmd);
      }
    }
    return out;
  }

  listWithOwner(): Array<{ cmd: SlashCommand; owner: string; fullName: string }> {
    const seen = new Set<SlashCommand>();
    const out: Array<{ cmd: SlashCommand; owner: string; fullName: string }> = [];
    for (const [fullName, { cmd, owner }] of this.cmds.entries()) {
      if (!seen.has(cmd)) {
        seen.add(cmd);
        out.push({ cmd, owner, fullName });
      }
    }
    return out;
  }

  /**
   * Parse a slash command line. Accepts both:
   *   `/cmd args`          → builtin command (owner=core)
   *   `/pluginName:cmd args` → plugin command
   * The command name is split at the first `:` if the prefix matches a known owner.
   */
  async dispatch(line: string, ctx: Context): Promise<{ exit?: boolean; message?: string } | null> {
    if (!line.startsWith('/')) return null;
    const trimmed = line.slice(1);
    const spaceIdx = trimmed.indexOf(' ');
    const firstColonIdx = trimmed.indexOf(':');

    let name: string;
    let args: string;

    if (firstColonIdx !== -1 && (spaceIdx === -1 || firstColonIdx < spaceIdx)) {
      // `/owner:cmd` or `/owner:cmd args` — plugin namespaced
      const prefix = trimmed.slice(0, firstColonIdx);
      name = trimmed.slice(0, spaceIdx === -1 ? undefined : spaceIdx);
      args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1);
      // Verify the prefix is a known owner
      const entry = this.cmds.get(name);
      if (!entry || entry.owner !== prefix) {
        // Not a namespaced plugin command — treat the whole thing as a builtin command name
        name = trimmed.slice(0, spaceIdx === -1 ? undefined : spaceIdx);
        args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1);
      }
    } else {
      name = trimmed.slice(0, spaceIdx === -1 ? undefined : spaceIdx);
      args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1);
    }

    const entry = this.cmds.get(name);
    if (!entry) {
      return { message: `Unknown command "/${name}". Type /help for a list.` };
    }
    const res = await entry.cmd.run(args, ctx);
    return res ?? {};
  }
}
