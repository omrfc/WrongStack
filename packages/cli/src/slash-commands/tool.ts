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
    '',
    'Modes:',
    '  simple   Short top-level description and usage hint',
    '  extend   Full description (default)',
    '',
    'Examples:',
    '  /tool read simple',
    '  /tool bash extend',
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

  function formatOverrides(): string {
    const configured = opts.configStore.get().tools.descriptionMode ?? {};
    const simple = Object.entries(configured)
      .filter(([, mode]) => normalizeToolDescriptionMode(mode) === 'simple')
      .map(([name]) => name)
      .sort();
    return [
      `${color.bold('Tool descriptions')} ${color.dim(`(default: desc:extend)`)}`,
      '',
      simple.length > 0
        ? `  ${formatDescriptionMode('simple')}: ${simple.map((name) => color.cyan(name)).join(', ')}`
        : `  ${formatDescriptionMode('simple')}: ${color.dim('none')}`,
      '',
      color.dim('  /tool <name> simple · /tool <name> extend · /tool list'),
    ].join('\n');
  }

  function formatList(): string {
    const header =
      `  ${color.dim(fit('tool', 28))} ` +
      `${color.dim(fit('owner', 28))} ` +
      color.dim('description');
    const rows = opts.toolRegistry.listWithOwner().map(({ tool }) => {
      const mode = getToolDescriptionMode(opts.toolRegistry, tool.name);
      const owner = opts.toolRegistry.ownerOf(tool.name) ?? 'core';
      return (
        `  ${fit(tool.name, 28)} ` +
        `${color.dim(fit(`[${owner}]`, 28))} ` +
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
    const tool = opts.toolRegistry.get(name);
    if (!tool) {
      return `${color.red('Unknown tool')}: ${name}. Use ${color.dim('/tools')} to list registered tools.`;
    }
    const mode = getToolDescriptionMode(opts.toolRegistry, name);
    return [
      `${color.bold(name)} description mode: ${formatDescriptionMode(mode)}`,
      '',
      color.dim(tool.description),
    ].join('\n');
  }

  return {
    name: 'tool',
    category: 'Config',
    description: 'Set per-tool description detail: simple or extend.',
    argsHint: '[<name> simple|extend]',
    help,
    async run(args) {
      if (!opts.configStore) {
        return { message: `${color.red('Error')} config store not available.` };
      }

      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? '').toLowerCase();
      if (!sub) return { message: formatOverrides() };
      if (sub === 'help' || sub === '--help') return { message: this.help ?? '' };
      if (sub === 'list') return { message: formatList() };

      const name = parts[0] ?? '';
      const tool = opts.toolRegistry.get(name);
      if (!tool) {
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
