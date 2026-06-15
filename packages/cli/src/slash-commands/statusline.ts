import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, ERROR_CODES, FsError, type SlashCommand } from '@wrongstack/core';
import { toErrorMessage } from '@wrongstack/core/utils';

const CONFIG_ENV = 'WRONGSTACK_STATUSLINE_CONFIG';

export interface StatuslineConfig {
  todos?: boolean | undefined;
  plan?: boolean | undefined;
  tasks?: boolean | undefined;
  fleet?: boolean | undefined;
  git?: boolean | undefined;
  elapsed?: boolean | undefined;
  context?: boolean | undefined;
  cost?: boolean | undefined;
  working_dir?: boolean | undefined;
}

const DEFAULTS: StatuslineConfig = {
  todos: true,
  plan: true,
  tasks: true,
  fleet: true,
  git: true,
  elapsed: true,
  context: true,
  cost: true,
  working_dir: true,
};

function resolveConfigPath(): string {
  return (
    process.env[CONFIG_ENV] ?? path.join(process.env.HOME ?? '', '.wrongstack', 'statusline.json')
  );
}

export async function loadStatuslineConfig(): Promise<StatuslineConfig> {
  const p = resolveConfigPath();
  try {
    const raw = await fs.readFile(p, 'utf8');
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<StatuslineConfig>) };
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
      message: toErrorMessage(err),
      code:
        err instanceof Error && err.message.includes('mkdir')
          ? ERROR_CODES.FS_MKDIR_FAILED
          : ERROR_CODES.FS_ATOMIC_WRITE_FAILED,
      path: p,
      cause: err,
    });
  }
}

export interface StatuslineCommandDeps {
  cwd: string;
  /** Current hidden items list. Written by the command when toggling. */
  hiddenItems: Array<
    'todos' | 'plan' | 'tasks' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost' | 'working_dir'
  >;
  setHiddenItems: (
    items: Array<
      'todos' | 'plan' | 'tasks' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost' | 'working_dir'
    >,
  ) => void;
  getConfig: () => Promise<StatuslineConfig>;
  setConfig: (cfg: StatuslineConfig) => Promise<void>;
}

/** Item descriptions for help display */
const ITEM_DESCRIPTIONS: Record<keyof StatuslineConfig, string> = {
  todos: 'Todo items (pending/in-progress/done counts)',
  plan: 'Plan board items (open/in-progress/done)',
  tasks: 'Task board items (structured work with type/priority)',
  fleet: 'Fleet agent status (running/idle/pending/completed)',
  git: 'Git branch name',
  elapsed: 'Session elapsed time',
  context: 'Context window usage (input tokens)',
  cost: 'Token cost estimate (input/output/total)',
  working_dir: 'Current working directory',
};

const ALL_CONFIG_KEYS: (keyof StatuslineConfig)[] = [
  'todos',
  'plan',
  'tasks',
  'fleet',
  'git',
  'elapsed',
  'context',
  'cost',
  'working_dir',
];

export function buildStatuslineCommand(deps: StatuslineCommandDeps): SlashCommand {
  return {
    name: 'statusline',
    category: 'Config',
    aliases: ['sl'],
    description: 'Customize status bar chips: /statusline [item] [on|off|reset]',
    help: [
      'Usage: /statusline [item] [on|off|reset]',
      '       /statusline              — show current config',
      '       /statusline <item>      — toggle item on/off',
      '       /statusline <item> on   — enable a chip',
      '       /statusline <item> off  — disable a chip',
      '       /statusline all on      — enable all chips',
      '       /statusline all off     — disable all chips',
      '       /statusline reset       — restore defaults',
      '',
      'Available items:',
      ...ALL_CONFIG_KEYS.map((k) => `  ${k.padEnd(12)} ${ITEM_DESCRIPTIONS[k]}`),
      '',
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
        for (const k of ALL_CONFIG_KEYS) {
          const val = cfg[k];
          if (val === undefined) continue;
          lines.push(`  ${val ? '●' : '○'} ${k.padEnd(12)} ${ITEM_DESCRIPTIONS[k]}`);
        }
        return { message: lines.join('\n') };
      }

      // Reset
      if (item === 'reset') {
        await deps.setConfig({ ...DEFAULTS });
        deps.setHiddenItems([]);
        return { message: 'StatusBar config reset to defaults.' };
      }

      // Group operation: all on / all off
      if (item === 'all') {
        const onOff = action?.toLowerCase();
        if (!onOff || (onOff !== 'on' && onOff !== 'off')) {
          return { message: 'Usage: /statusline all on|off' };
        }
        const next: StatuslineConfig = {};
        for (const k of ALL_CONFIG_KEYS) {
          next[k] = onOff === 'on';
        }
        await deps.setConfig(next);
        deps.setHiddenItems(onOff === 'off' ? [...ALL_CONFIG_KEYS] : []);
        return { message: `statusline all: ${onOff === 'on' ? 'showing all chips' : 'hiding all chips'}` };
      }

      // Single item toggle (no on/off specified)
      const validItems = ALL_CONFIG_KEYS;
      if (!validItems.includes(item as keyof StatuslineConfig)) {
        return {
          message: `Unknown item "${item}". Run /statusline to see available items.`,
        };
      }

      // If no action specified, toggle the item
      const onOff = action?.toLowerCase();
      if (!onOff) {
        const currentValue = cfg[item as keyof StatuslineConfig] ?? true;
        const newValue = !currentValue;
        const next = { ...cfg, [item]: newValue };
        await deps.setConfig(next);
        if (newValue) {
          deps.setHiddenItems(deps.hiddenItems.filter((i) => i !== item));
        } else {
          deps.setHiddenItems([...deps.hiddenItems, item as (typeof deps.hiddenItems)[number]]);
        }
        return { message: `statusline ${item}: ${newValue ? 'on' : 'off'}` };
      }

      if (onOff !== 'on' && onOff !== 'off') {
        return { message: `Usage: /statusline ${item} on|off` };
      }

      const next = { ...cfg, [item]: onOff === 'on' };
      await deps.setConfig(next);

      // Sync hiddenItems list with TUI
      if (onOff === 'off') {
        deps.setHiddenItems([...deps.hiddenItems, item as (typeof deps.hiddenItems)[number]]);
      } else {
        deps.setHiddenItems(deps.hiddenItems.filter((i) => i !== item));
      }

      return { message: `statusline ${item}: ${onOff}` };
    },
  };
}
