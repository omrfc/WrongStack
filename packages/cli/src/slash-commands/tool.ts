import {
  color,
  getToolDescriptionMode,
  normalizeToolDescriptionMode,
  noOpVault,
  setToolDescriptionMode,
  type SlashCommand,
  type ToolDescriptionMode,
  type ToolsConfig,
} from '@wrongstack/core';
import { toErrorMessage } from '@wrongstack/core/utils';
import { persistConfigSetting } from '../settings-menu.js';
import type { SlashCommandContext } from './index.js';

function fit(text: string, width: number): string {
  if (text.length <= width) return text.padEnd(width);
  return `${text.slice(0, Math.max(0, width - 3))}...`;
}

function formatDescriptionMode(mode: ToolDescriptionMode): string {
  const raw = `desc:${mode}`;
  return mode === 'simple' ? color.amber(raw) : color.cyan(raw);
}

export function buildToolCommand(opts: SlashCommandContext): SlashCommand {
  const help = [
    'Usage:',
    '  /tool                         Show tool description-mode overrides',
    '  /tool list                    List every tool and its description mode',
    '  /tool <name>                  Show one tool mode',
    '  /tool <name> simple           Use a 1-2 line tool description',
    '  /tool <name> extend           Use the full/extended tool description',
    '  /tool disable <name>          Hide a tool from the registry and system prompt',
    '  /tool enable <name>           Restore a disabled tool',
    '  /tool enable-all              Restore all disabled tools',
    '',
    'Modes:',
    '  simple   Short top-level description and usage hint',
    '  extend   Full description (default)',
    '',
    'Examples:',
    '  /tool read simple',
    '  /tool bash extend',
    '  /tool disable bash',
    '  /tool enable bash',
    '  /tool enable-all',
  ].join('\n');

  function getCurrentTools(): ToolsConfig {
    return opts.configStore.get().tools;
  }

  function nextToolsConfig(name: string, mode: ToolDescriptionMode): ToolsConfig {
    const current = getCurrentTools();
    const descriptionMode = { ...(current.descriptionMode ?? {}) };
    if (mode === 'simple') {
      descriptionMode[name] = 'simple';
    } else {
      delete descriptionMode[name];
    }
    return { ...current, descriptionMode };
  }

  async function persistMode(name: string, mode: ToolDescriptionMode): Promise<boolean> {
    const nextTools = nextToolsConfig(name, mode);
    if (!opts.paths) {
      opts.configStore.update({ tools: nextTools });
      return false;
    }

    await persistConfigSetting(
      {
        configStore: opts.configStore,
        globalConfigPath: opts.paths.globalConfig,
        inProjectConfigPath: opts.paths.inProjectConfig,
        vault: noOpVault,
      },
      (cfg) => {
        cfg.tools = nextTools;
      },
    );
    return true;
  }

  // ── Disable / enable helpers ─────────────────────────────────────

  function currentDisabledSet(): Set<string> {
    return new Set(getCurrentTools().disabledTools ?? []);
  }

  function persistDisabled(names: string[]): Promise<void> {
    const current = getCurrentTools();
    const nextTools: ToolsConfig = { ...current, disabledTools: names };
    if (!opts.paths) {
      opts.configStore.update({ tools: nextTools });
      return Promise.resolve();
    }
    return persistConfigSetting(
      {
        configStore: opts.configStore,
        globalConfigPath: opts.paths.globalConfig,
        inProjectConfigPath: opts.paths.inProjectConfig,
        vault: noOpVault,
      },
      (cfg) => {
        cfg.tools = nextTools;
      },
    );
  }

  // ── Formatting helpers ───────────────────────────────────────────

  function formatOverrides(): string {
    const configured = opts.configStore.get().tools.descriptionMode ?? {};
    const simple = Object.entries(configured)
      .filter(([, mode]) => normalizeToolDescriptionMode(mode) === 'simple')
      .map(([name]) => name)
      .sort();
    const disabled = opts.toolRegistry.listDisabled();
    const lines: string[] = [
      `${color.bold('Tool descriptions')} ${color.dim(`(default: desc:extend)`)}`,
      '',
      simple.length > 0
        ? `  ${formatDescriptionMode('simple')}: ${simple.map((name) => color.cyan(name)).join(', ')}`
        : `  ${formatDescriptionMode('simple')}: ${color.dim('none')}`,
      '',
    ];
    if (disabled.length > 0) {
      lines.push(
        `${color.bold('Disabled tools')}`,
        '',
        `  ${color.red('disabled')}: ${disabled.map(({ tool }) => color.dim(tool.name)).join(', ')}`,
        '',
      );
    }
    lines.push(color.dim('  /tool <name> simple · /tool <name> extend · /tool list · /tool disable|enable <name>'));
    return lines.join('\n');
  }

  function formatList(): string {
    const header =
      `  ${color.dim(fit('tool', 28))} ` +
      `${color.dim(fit('owner', 28))} ` +
      `${color.dim(fit('status', 10))} ` +
      color.dim('description');
    const rows = opts.toolRegistry.listWithOwner().map(({ tool }) => {
      const mode = getToolDescriptionMode(opts.toolRegistry, tool.name);
      const owner = opts.toolRegistry.ownerOf(tool.name) ?? 'core';
      const status = opts.toolRegistry.isDisabled(tool.name) ? color.red('disabled') : color.green('active');
      return (
        `  ${fit(tool.name, 28)} ` +
        `${color.dim(fit(`[${owner}]`, 28))} ` +
        `${fit(status, 10)} ` +
        formatDescriptionMode(mode)
      );
    });
    return [
      `${color.bold('Tool description modes')} ${color.dim('(default: desc:extend)')}`,
      '',
      header,
      ...rows,
    ].join('\n');
  }

  function formatOne(name: string): string {
    const reg = opts.toolRegistry;
    const tool = reg.get(name);
    if (!tool) {
      if (reg.isDisabled(name)) {
        return `${color.amber(name)} is disabled. Use ${color.dim(`/tool enable ${name}`)} to restore.`;
      }
      return `${color.red('Unknown tool')}: ${name}. Use ${color.dim('/tools')} to list registered tools.`;
    }
    const mode = getToolDescriptionMode(reg, name);
    const status = reg.isDisabled(name) ? color.red('disabled') : color.green('active');
    return [
      `${color.bold(name)} ${status}`,
      `description mode: ${formatDescriptionMode(mode)}`,
      '',
      color.dim(tool.description),
    ].join('\n');
  }

  // ── Sub-command dispatch ────────────────────────────────────────

  async function cmdEnable(name: string): Promise<string> {
    const reg = opts.toolRegistry;
    if (!reg.isDisabled(name)) {
      return `${color.amber(name)} is not disabled.`;
    }
    const ok = reg.enable(name);
    if (!ok) return `${color.red('Could not enable')}: ${name}.`;

    const disabled = currentDisabledSet();
    disabled.delete(name);
    await persistDisabled(Array.from(disabled));

    return `${color.green('✓')} ${color.cyan(name)} re-enabled — will appear in next provider request.`;
  }

  async function cmdEnableAll(): Promise<string> {
    const reg = opts.toolRegistry;
    const count = reg.enableAll();
    if (count === 0) return `${color.amber('No disabled tools to re-enable.')}`;
    await persistDisabled([]);
    return `${color.green('✓')} All ${count} disabled tool(s) re-enabled.`;
  }

  async function cmdDisable(name: string): Promise<string> {
    const reg = opts.toolRegistry;
    const tool = reg.get(name);
    if (!tool) {
      if (reg.isDisabled(name)) {
        return `${color.amber(name)} is already disabled.`;
      }
      return `${color.red('Unknown tool')}: ${name}. Use ${color.dim('/tools')} to list registered tools.`;
    }
    const ok = reg.disable(name);
    if (!ok) return `${color.red('Could not disable')}: ${name}.`;

    const disabled = currentDisabledSet();
    disabled.add(name);
    await persistDisabled(Array.from(disabled));

    return `${color.green('✓')} ${color.cyan(name)} disabled — removed from system prompt and tool registry.`;
  }

  return {
    name: 'tool',
    category: 'Config',
    description: 'Set per-tool description detail: simple or extend. Disable/enable tools.',
    argsHint: '[<name> simple|extend|disable|enable]',
    help,
    async run(args) {
      if (!opts.configStore) {
        return { message: `${color.red('Error')} config store not available.` };
      }

      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? '').toLowerCase();
      if (!sub) return { message: formatOverrides() };
      if (sub === 'help' || sub === '--help') return { message: this.help ?? '' };

      // ── Sub-command routing ──────────────────────────────────────

      if (sub === 'list') return { message: formatList() };

      // enable-all
      if (sub === 'enable-all') {
        try {
          return { message: await cmdEnableAll() };
        } catch (err) {
          return { message: `${color.red('Error')}: ${toErrorMessage(err)}` };
        }
      }

      const name = parts[0] ?? '';
      if (!name) return { message: formatOverrides() };

      // disable <name>
      if (sub === 'disable') {
        const target = parts[1];
        if (!target) return { message: `${color.amber('Usage:')} /tool disable <name>` };
        try {
          return { message: await cmdDisable(target) };
        } catch (err) {
          return { message: `${color.red('Error')}: ${toErrorMessage(err)}` };
        }
      }

      // enable <name>
      if (sub === 'enable') {
        const target = parts[1];
        if (!target) return { message: `${color.amber('Usage:')} /tool enable <name>` };
        try {
          return { message: await cmdEnable(target) };
        } catch (err) {
          return { message: `${color.red('Error')}: ${toErrorMessage(err)}` };
        }
      }

      // ── Existing description mode commands ───────────────────────

      if (!opts.toolRegistry.get(name) && !opts.toolRegistry.isDisabled(name)) {
        return {
          message: `${color.red('Unknown tool')}: ${name}. Use ${color.dim('/tools')} to list registered tools.`,
        };
      }

      if (parts.length === 1) return { message: formatOne(name) };

      const mode = normalizeToolDescriptionMode(parts[1]);
      if (!mode) {
        return { message: `${color.amber('Usage:')} /tool ${name} simple|extend` };
      }

      try {
        const persisted = await persistMode(name, mode);
        setToolDescriptionMode(opts.toolRegistry, name, mode);
        const persistence = persisted
          ? color.dim('saved')
          : color.dim('runtime only; config paths unavailable');
        return {
          message: `${color.green('✓')} ${color.cyan(name)} description mode -> ${formatDescriptionMode(mode)} ${persistence}`,
        };
      } catch (err) {
        return {
          message: `${color.red('Could not save tool setting')}: ${toErrorMessage(err)}`,
        };
      }
    },
  };
}
