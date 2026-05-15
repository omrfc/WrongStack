import type { Context } from '../core/context.js';

/**
 * A slash command registered with the CLI or available to plugins.
 * Plugins receive a view of the registry via PluginAPI.slashCommands.
 *
 * Commands registered by plugins use a namespaced name: `pluginName:commandName`.
 * This prevents collisions with built-in commands and other plugins.
 */
export interface SlashCommand {
  /** Unique command name. For plugins: `pluginName:commandName`. */
  name: string;
  /** Short aliases — also prefixed automatically: `pluginName:alias`. */
  aliases?: string[];
  description: string;
  /**
   * Optional detailed help shown by `/help <name>`. Use this for usage,
   * arguments, examples, side-effects — anything that doesn't fit in
   * `description`. Renders verbatim, so format with line breaks.
   * If absent, `/help <name>` falls back to `description`.
   */
  help?: string;
  /**
   * Execute the command.
   * @param args Everything after the command name (trimmed by dispatch).
   * @param ctx The current agent context.
   * @returns `{ exit: true }` to quit the REPL. `{ message }` to print and continue.
   */
  run(args: string, ctx: Context): Promise<{ exit?: boolean; message?: string } | void>;
}
