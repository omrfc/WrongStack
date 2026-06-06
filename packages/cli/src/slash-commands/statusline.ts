import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, FsError, ERROR_CODES, type SlashCommand } from '@wrongstack/core';

const CONFIG_ENV = 'WRONGSTACK_STATUSLINE_CONFIG';

export interface StatuslineConfig {
  todos?: boolean;
  plan?: boolean;
  fleet?: boolean;
  git?: boolean;
  elapsed?: boolean;
  context?: boolean;
  cost?: boolean;
}

const DEFAULTS: StatuslineConfig = {
  todos: true,
  plan: true,
  fleet: true,
  git: true,
  elapsed: true,
  context: true,
  cost: true,
};

function resolveConfigPath(): string {
  return process.env[CONFIG_ENV] ?? path.join(process.env.HOME ?? '', '.wrongstack', 'statusline.json');
}

export async function loadStatuslineConfig(): Promise<StatuslineConfig> {
  const p = resolveConfigPath();
  try {
    const raw = await fs.readFile(p, 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) as Partial<StatuslineConfig> };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveStatuslineConfig(cfg: StatuslineConfig): Promise<void> {
  const p = resolveConfigPath();
  try {
    await fs.mkdir(path.dirname(p), { recursive: true });
    // atomicWrite: torn write would leave statusline.json malformed and the
    // next load would silently fall back to DEFAULTS, losing user preferences.
    await atomicWrite(p, JSON.stringify(cfg, null, 2));
  } catch (err) {
    throw new FsError({
      message: err instanceof Error ? err.message : String(err),
      code: err instanceof Error && err.message.includes('mkdir') ? ERROR_CODES.FS_MKDIR_FAILED : ERROR_CODES.FS_ATOMIC_WRITE_FAILED,
      path: p,
      cause: err,
    });
  }
}

export interface StatuslineCommandDeps {
  cwd: string;
  /** Current hidden items list. Written by the command when toggling. */
  hiddenItems: Array<'todos' | 'plan' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost'>;
  setHiddenItems: (items: Array<'todos' | 'plan' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost'>) => void;
  getConfig: () => Promise<StatuslineConfig>;
  setConfig: (cfg: StatuslineConfig) => Promise<void>;
}

export function buildStatuslineCommand(deps: StatuslineCommandDeps): SlashCommand {
  return {
    name: 'statusline',
    category: 'Config',
    aliases: ['sl'],
    description: 'Customize status bar chips: /statusline [item] [on|off] or /statusline reset',
    help: [
      'Usage: /statusline [item] [on|off]',
      '       /statusline            — show current config',
      '       /statusline <item> on  — enable a chip',
      '       /statusline <item> off — disable a chip',
      '       /statusline reset      — restore defaults',
      '',
      'Available items: todos, plan, fleet, git, elapsed, context, cost',
      'Persistent across sessions (saved to ~/.wrongstack/statusline.json).',
    ].join('\n'),
    async run(args: string) {
      const cfg = await deps.getConfig();
      const trimmed = args.trim();
      const parts = trimmed.split(/\s+/);
      const [item, action] = parts;

      // No args → show current config
      if (!item) {
        const lines = ['StatusBar chips:'];
        const items: (keyof StatuslineConfig)[] = [
          'todos', 'plan', 'fleet', 'git', 'elapsed', 'context', 'cost',
        ];
        for (const k of items) {
          const val = cfg[k];
          if (val === undefined) continue;
          lines.push(`  ${val ? '●' : '○'} ${k}`);
        }
        return { message: lines.join('\n') };
      }

      // Reset
      if (item === 'reset') {
        await deps.setConfig({ ...DEFAULTS });
        deps.setHiddenItems([]);
        return { message: 'StatusBar config reset to defaults.' };
      }

      // Toggle
      const validItems: (keyof StatuslineConfig)[] = [
        'todos', 'plan', 'fleet', 'git', 'elapsed', 'context', 'cost',
      ];
      if (!validItems.includes(item as keyof StatuslineConfig)) {
        return {
          message: `Unknown item "${item}". Available: ${validItems.join(', ')}. Usage: /statusline <item> on|off`,
        };
      }

      const onOff = action?.toLowerCase();
      if (!onOff || (onOff !== 'on' && onOff !== 'off')) {
        return { message: `Usage: /statusline ${item} on|off` };
      }

      const next = { ...cfg, [item]: onOff === 'on' };
      await deps.setConfig(next);

      // Sync hiddenItems list with TUI
      if (onOff === 'off') {
        deps.setHiddenItems([...deps.hiddenItems, item as typeof deps.hiddenItems[number]]);
      } else {
        deps.setHiddenItems(deps.hiddenItems.filter((i) => i !== item));
      }

      return { message: `statusline ${item}: ${onOff}` };
    },
  };
}