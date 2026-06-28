import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicWrite, ERROR_CODES, FsError, type SlashCommand } from '@wrongstack/core';
import { toErrorMessage } from '@wrongstack/core/utils';

const CONFIG_ENV = 'WRONGSTACK_STATUSLINE_CONFIG';

export interface StatuslineConfig {
  version?: boolean | undefined;
  state?: boolean | undefined;
  model?: boolean | undefined;
  todos?: boolean | undefined;
  plan?: boolean | undefined;
  tasks?: boolean | undefined;
  fleet?: boolean | undefined;
  fleet_agents?: boolean | undefined;
  git?: boolean | undefined;
  elapsed?: boolean | undefined;
  context?: boolean | undefined;
  tokens?: boolean | undefined;
  cache?: boolean | undefined;
  cost?: boolean | undefined;
  queue?: boolean | undefined;
  processes?: boolean | undefined;
  hint?: boolean | undefined;
  index?: boolean | undefined;
  breaker?: boolean | undefined;
  working_dir?: boolean | undefined;
  project?: boolean | undefined;
  yolo?: boolean | undefined;
  autonomy?: boolean | undefined;
  eternal_stage?: boolean | undefined;
  goal?: boolean | undefined;
  mode?: boolean | undefined;
  auto_proceed?: boolean | undefined;
  sessions?: boolean | undefined;
  tools?: boolean | undefined;
  token_saving?: boolean | undefined;
  brain?: boolean | undefined;
  mailbox?: boolean | undefined;
  enhance?: boolean | undefined;
  debug_stream?: boolean | undefined;
  next_steps?: boolean | undefined;
}

export const DEFAULTS: StatuslineConfig = {
  version: true,
  state: true,
  model: true,
  todos: true,
  plan: true,
  tasks: true,
  fleet: true,
  fleet_agents: true,
  git: true,
  elapsed: true,
  context: true,
  tokens: true,
  cache: true,
  cost: true,
  queue: true,
  processes: true,
  hint: true,
  index: true,
  breaker: true,
  working_dir: true,
  project: true,
  yolo: true,
  autonomy: true,
  eternal_stage: true,
  goal: true,
  mode: true,
  auto_proceed: true,
  sessions: true,
  tools: true,
  token_saving: true,
  brain: true,
  mailbox: true,
  enhance: true,
  debug_stream: true,
  next_steps: true,
};

export type StatuslineConfigKey = keyof StatuslineConfig;

export const STATUSLINE_CONFIG_KEYS: StatuslineConfigKey[] = [
  'version',
  'state',
  'model',
  'context',
  'tokens',
  'cache',
  'cost',
  'queue',
  'processes',
  'hint',
  'index',
  'breaker',
  'yolo',
  'autonomy',
  'eternal_stage',
  'elapsed',
  'project',
  'working_dir',
  'goal',
  'mode',
  'auto_proceed',
  'git',
  'sessions',
  'tools',
  'token_saving',
  'todos',
  'plan',
  'tasks',
  'fleet',
  'brain',
  'debug_stream',
  'enhance',
  'next_steps',
  'mailbox',
  'fleet_agents',
];

function resolveConfigPath(): string {
  // os.homedir() (USERPROFILE on Windows) is the canonical home resolver used
  // across the codebase. Falling back to `process.env.HOME ?? ''` alone breaks
  // on native Windows (PowerShell's $HOME is not an env var), where it would
  // resolve to a cwd-relative `.wrongstack/statusline.json`. HOME is still
  // honored first so the env-overriding tests keep working.
  return (
    process.env[CONFIG_ENV] ??
    path.join(process.env.HOME ?? os.homedir(), '.wrongstack', 'statusline.json')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeStatuslineConfig(value: unknown): StatuslineConfig {
  const cfg: StatuslineConfig = { ...DEFAULTS };
  if (!isRecord(value)) return cfg;
  for (const key of STATUSLINE_CONFIG_KEYS) {
    const raw = value[key];
    if (typeof raw === 'boolean') cfg[key] = raw;
  }
  return cfg;
}

function isMissingKnownStatuslineKeys(value: unknown): boolean {
  if (!isRecord(value)) return true;
  return STATUSLINE_CONFIG_KEYS.some((key) => typeof value[key] !== 'boolean');
}

function hasFsCode(err: unknown, code: string): boolean {
  return isRecord(err) && err['code'] === code;
}

export async function loadStatuslineConfig(): Promise<StatuslineConfig> {
  const p = resolveConfigPath();
  try {
    const raw = await fs.readFile(p, 'utf8');
    return normalizeStatuslineConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULTS };
  }
}

export async function ensureStatuslineConfig(): Promise<StatuslineConfig> {
  const p = resolveConfigPath();
  try {
    const raw = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(raw);
    const cfg = normalizeStatuslineConfig(parsed);
    if (isMissingKnownStatuslineKeys(parsed)) {
      await saveStatuslineConfig(cfg);
    }
    return cfg;
  } catch (err) {
    if (hasFsCode(err, 'ENOENT')) {
      const cfg = { ...DEFAULTS };
      await saveStatuslineConfig(cfg);
      return cfg;
    }
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
    StatuslineConfigKey
  >;
  setHiddenItems: (
    items: Array<
      StatuslineConfigKey
    >,
  ) => void;
  getConfig: () => Promise<StatuslineConfig>;
  setConfig: (cfg: StatuslineConfig) => Promise<void>;
  /**
   * Atomically updates hidden items in memory AND persists to disk.
   * Used by the TUI statusline picker.
   */
  saveStatuslineHiddenItems?: (
    items: Array<
      StatuslineConfigKey
    >,
  ) => Promise<void>;
}

/** Item descriptions for help display */
const ITEM_DESCRIPTIONS: Record<keyof StatuslineConfig, string> = {
  version: 'WrongStack version chip',
  state: 'Agent run state / thinking spinner',
  model: 'Current provider/model id',
  todos: 'Todo items (pending/in-progress/done counts)',
  plan: 'Plan board items (open/in-progress/done)',
  tasks: 'Task board items (structured work with type/priority)',
  fleet: 'Fleet agent status (running/idle/pending/completed)',
  fleet_agents: 'Per-agent live detail row',
  git: 'Git branch name',
  elapsed: 'Session elapsed time',
  context: 'Context window usage (input tokens)',
  tokens: 'Input/output token counters',
  cache: 'Prompt cache hit ratio',
  cost: 'Token cost estimate (input/output/total)',
  queue: 'Queued prompt count',
  processes: 'Tracked shell/process count',
  hint: 'Transient status hint text',
  index: 'Codebase indexing status',
  breaker: 'Process breaker countdown',
  working_dir: 'Current working directory',
  project: 'Project name',
  yolo: 'YOLO permission mode',
  autonomy: 'Autonomy mode',
  eternal_stage: 'Autonomy stage',
  goal: 'Active goal summary',
  mode: 'Active agent mode label',
  auto_proceed: 'Auto-proceed countdown',
  sessions: 'Live session count',
  tools: 'Registered tool count',
  token_saving: 'Token-saving mode indicator',
  brain: 'Brain arbiter decisions',
  mailbox: 'Mailbox unread messages and peers',
  enhance: 'Prompt-enhance countdown',
  debug_stream: 'Stream debug telemetry',
  next_steps: 'Next-step auto-submit countdown',
};

const ALL_CONFIG_KEYS = STATUSLINE_CONFIG_KEYS;

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
