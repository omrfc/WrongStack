import * as fs from 'node:fs/promises';
import { type Config, type PluginConfig, atomicWrite } from '@wrongstack/core';

export const OFFICIAL_PLUGINS = [
  {
    alias: 'telegram',
    specifier: '@wrongstack/telegram',
    description: 'Telegram bridge for prompts, notifications, and slash commands.',
  },
  {
    alias: 'lsp',
    specifier: '@wrongstack/plug-lsp',
    description: 'Language Server Protocol tools for code intelligence.',
  },
] as const;

export interface PluginManagementDeps {
  config: Config;
  configPath: string;
}

export interface PluginManagementResult {
  code: number;
  level: 'output' | 'info' | 'error';
  message: string;
  patch?: {
    plugins?: (string | PluginConfig)[];
    features?: Record<string, unknown>;
  };
  restartRequired?: boolean;
}

const OFFICIAL_ALIASES = new Map<string, string>(
  OFFICIAL_PLUGINS.flatMap((p) => [
    [p.alias, p.specifier],
    [p.specifier, p.specifier],
  ]),
);

export async function runPluginManagementCommand(
  args: string[],
  deps: PluginManagementDeps,
): Promise<PluginManagementResult> {
  const sub = args[0];
  if (!sub || sub === 'list' || sub === 'status') {
    return {
      code: 0,
      level: 'output',
      message: renderConfiguredPlugins(deps.config),
    };
  }
  if (sub === 'official' || sub === 'officials') {
    return {
      code: 0,
      level: 'output',
      message: renderOfficialPlugins(deps.config),
    };
  }
  if (sub === 'add' || sub === 'install') {
    const spec = args[1];
    if (!spec) {
      return errorResult('Usage: wstack plugin add <specifier|official-alias> [--disabled]');
    }
    return upsertPlugin(
      resolvePluginSpecifier(spec),
      { enabled: !args.includes('--disabled') },
      deps,
      'Added',
    );
  }
  if (sub === 'remove' || sub === 'rm' || sub === 'uninstall') {
    const spec = args[1];
    if (!spec) {
      return errorResult('Usage: wstack plugin remove <specifier|official-alias>');
    }
    return removePlugin(resolvePluginSpecifier(spec), deps);
  }
  if (sub === 'enable' || sub === 'disable') {
    const spec = args[1];
    if (!spec) {
      return errorResult(`Usage: wstack plugin ${sub} <specifier|official-alias>`);
    }
    return upsertPlugin(
      resolvePluginSpecifier(spec),
      { enabled: sub === 'enable' },
      deps,
      sub === 'enable' ? 'Enabled' : 'Disabled',
    );
  }
  return errorResult(
    `Unknown plugin subcommand: ${sub}\nUsage: wstack plugin [list|status|official|add|install|remove|enable|disable]`,
  );
}

export function resolvePluginSpecifier(input: string): string {
  return OFFICIAL_ALIASES.get(input.toLowerCase()) ?? input;
}

export function renderOfficialPlugins(config?: Config): string {
  return [
    'Official plugins:',
    ...OFFICIAL_PLUGINS.map((p) => {
      const state = config ? officialPluginState(config, p.specifier) : '';
      const status = state ? `${state.padEnd(14)} ` : '';
      return `  ${p.alias.padEnd(12)} ${status}${p.specifier.padEnd(24)} ${p.description}`;
    }),
    '',
    'Use `wstack plugin add <alias>` or `/plugin install <alias>`.',
  ].join('\n');
}

export function renderConfiguredPlugins(config: Config): string {
  const plugins = config.plugins ?? [];
  if (plugins.length === 0) {
    return [
      'No plugins configured.',
      'Use `wstack plugin add <specifier>` or `/plugin install <official-alias>`.',
    ].join('\n');
  }
  return plugins
    .map((p) => {
      const name = pluginName(p);
      const enabled = typeof p === 'object' && p.enabled === false ? 'disabled' : 'enabled';
      const official = OFFICIAL_PLUGINS.find((entry) => entry.specifier === name);
      const suffix = official ? ` (${official.alias})` : '';
      return `  ${`${name}${suffix}`.padEnd(44)} ${enabled}`;
    })
    .join('\n');
}

async function readConfig(file: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function pluginName(p: string | PluginConfig): string {
  return typeof p === 'string' ? p : p.name;
}

function pluginEntry(spec: string, enabled: boolean): string | PluginConfig {
  return enabled ? spec : { name: spec, enabled: false };
}

function officialPluginState(
  config: Config,
  spec: string,
): 'enabled' | 'disabled' | 'not configured' {
  const match = (config.plugins ?? []).find((p) => pluginName(p) === spec);
  if (!match) return 'not configured';
  return typeof match === 'object' && match.enabled === false ? 'disabled' : 'enabled';
}

async function upsertPlugin(
  spec: string,
  opts: { enabled: boolean },
  deps: PluginManagementDeps,
  verb: string,
): Promise<PluginManagementResult> {
  const existing = await readConfig(deps.configPath);
  const plugins = Array.isArray(existing.plugins)
    ? (existing.plugins as Array<string | PluginConfig>)
    : [];
  const idx = plugins.findIndex((p) => pluginName(p) === spec);
  const nextEntry = pluginEntry(spec, opts.enabled);
  if (idx >= 0) plugins[idx] = nextEntry;
  else plugins.push(nextEntry);
  const features = {
    ...(isRecord(deps.config.features) ? deps.config.features : {}),
    ...(isRecord(existing.features) ? existing.features : {}),
    plugins: true,
  };
  existing.plugins = plugins;
  existing.features = features;
  await atomicWrite(deps.configPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
  return {
    code: 0,
    level: 'info',
    message: `${verb} "${spec}" (${opts.enabled ? 'enabled' : 'disabled'}). Config written to ${deps.configPath}.`,
    patch: { plugins, features },
    restartRequired: true,
  };
}

async function removePlugin(
  spec: string,
  deps: PluginManagementDeps,
): Promise<PluginManagementResult> {
  const existing = await readConfig(deps.configPath);
  const plugins = Array.isArray(existing.plugins)
    ? (existing.plugins as Array<string | PluginConfig>)
    : [];
  const next = plugins.filter((p) => pluginName(p) !== spec);
  if (next.length === plugins.length) {
    return errorResult(`Plugin "${spec}" not in config.`);
  }
  existing.plugins = next;
  await atomicWrite(deps.configPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
  return {
    code: 0,
    level: 'info',
    message: `Removed "${spec}" from config.`,
    patch: { plugins: next },
    restartRequired: true,
  };
}

function errorResult(message: string): PluginManagementResult {
  return { code: 1, level: 'error', message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
