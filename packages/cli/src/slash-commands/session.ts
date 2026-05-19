import { color } from '@wrongstack/core';
import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

export function buildSaveCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'save',
    description: 'Save current session (auto by default; this forces flush).',
    async run(_args, ctx) {
      await ctx.session.append({
        type: 'session_end',
        ts: new Date().toISOString(),
        usage: opts.tokenCounter.total(),
      });
      return { message: `Session ${ctx.session.id} flushed.` };
    },
  };
}

export function buildLoadCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'resume',
    aliases: ['load', 'sessions'],
    description: 'List recent sessions.',
    async run() {
      if (!opts.sessionStore) return { message: 'No session store configured.' };
      const list = await opts.sessionStore.list(10);
      if (list.length === 0) return { message: 'No saved sessions.' };
      const lines = list.map(
        (s) =>
          `  ${s.id}  ${color.dim(s.startedAt)}  ${color.dim(`${s.tokenTotal} tok`)}  ${s.title}`,
      );
      const msg = `Recent sessions:\n${lines.join('\n')}\n\n${color.dim(`Resume one with: wstack resume ${list[0]?.id ?? '<id>'}\n`)}`;
      opts.renderer.write(msg);
      return { message: msg };
    },
  };
}

export function buildExitCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'exit',
    aliases: ['quit', 'q'],
    description: 'Exit the REPL.',
    async run() {
      // Check for uncommitted changes before exit
      if (opts.onBeforeExit) {
        const result = await opts.onBeforeExit();
        if (result?.abort) {
          return { message: result.message ?? 'Exit aborted.' };
        }
      }
      opts.onExit?.();
      return { exit: true };
    },
  };
}
