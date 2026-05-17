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
   * Optional compact argument hint for interactive menus. This is not parsed
   * by the registry; it only helps TUI/REPL surfaces show the expected shape,
   * for example `[list|install <alias>|disable <name>]`.
   */
  argsHint?: string;
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
   * @returns `{ exit: true }` to quit the REPL. `{ message }` to print and
   * continue. `{ runText }` to send a follow-up user-role message to the
   * model immediately (e.g. `/steer <text>` builds a STEERING preamble
   * here and asks the TUI to run it as the next turn). The TUI prints
   * `message` first (if any) so the user sees the slash result before
   * the model's response starts streaming.
   */
  run(
    args: string,
    ctx: Context,
  ): Promise<{ exit?: boolean; message?: string; runText?: string } | void>;
}
