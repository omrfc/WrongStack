import type { Context } from '../core/context.js';

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  run(args: string, ctx: Context): Promise<{ exit?: boolean; message?: string } | void>;
}

export class SlashCommandRegistry {
  private readonly cmds = new Map<string, SlashCommand>();

  register(cmd: SlashCommand): void {
    if (this.cmds.has(cmd.name)) {
      throw new Error(`Slash command "${cmd.name}" already registered`);
    }
    this.cmds.set(cmd.name, cmd);
    for (const a of cmd.aliases ?? []) this.cmds.set(a, cmd);
  }

  get(name: string): SlashCommand | undefined {
    return this.cmds.get(name);
  }

  list(): SlashCommand[] {
    const seen = new Set<SlashCommand>();
    const out: SlashCommand[] = [];
    for (const cmd of this.cmds.values()) {
      if (!seen.has(cmd)) {
        seen.add(cmd);
        out.push(cmd);
      }
    }
    return out;
  }

  async dispatch(line: string, ctx: Context): Promise<{ exit?: boolean; message?: string } | null> {
    if (!line.startsWith('/')) return null;
    const idx = line.indexOf(' ');
    const name = idx === -1 ? line.slice(1) : line.slice(1, idx);
    const args = idx === -1 ? '' : line.slice(idx + 1);
    const cmd = this.cmds.get(name);
    if (!cmd) {
      return { message: `Unknown command "/${name}". Type /help for a list.` };
    }
    const res = await cmd.run(args, ctx);
    return res ?? {};
  }
}
