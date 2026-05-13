import type { Plugin, PluginAPI } from '../types/plugin.js';
import type { Logger } from '../types/logger.js';

export const KERNEL_API_VERSION = '0.0.1';

export interface LoadPluginsOptions {
  apiFactory: (plugin: Plugin) => PluginAPI;
  log: Logger;
  kernelApiVersion?: string;
}

function parseSemver(v: string): [number, number, number] {
  const parts = v.replace(/^[^0-9]*/, '').split('.').map((s) => Number.parseInt(s, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function satisfies(range: string, kernelVersion: string): boolean {
  const [kMaj, kMin, kPatch] = parseSemver(kernelVersion);
  const trimmed = range.trim();
  const op = trimmed.startsWith('^') ? '^' : trimmed.startsWith('~') ? '~' : '=';
  const ver = trimmed.replace(/^[\^~=]/, '');
  const [rMaj, rMin, rPatch] = parseSemver(ver);
  if (op === '^') {
    if (rMaj === 0) return kMaj === 0 && kMin === rMin && kPatch >= rPatch;
    return kMaj === rMaj && (kMin > rMin || (kMin === rMin && kPatch >= rPatch));
  }
  if (op === '~') {
    return kMaj === rMaj && kMin === rMin && kPatch >= rPatch;
  }
  return kMaj === rMaj && kMin === rMin && kPatch === rPatch;
}

function topoSort(plugins: Plugin[]): Plugin[] {
  const map = new Map<string, Plugin>();
  for (const p of plugins) map.set(p.name, p);
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: Plugin[] = [];

  const visit = (p: Plugin, stack: string[]) => {
    if (visited.has(p.name)) return;
    if (visiting.has(p.name)) {
      throw new Error(`Plugin dependency cycle: ${[...stack, p.name].join(' -> ')}`);
    }
    visiting.add(p.name);
    for (const dep of p.dependsOn ?? []) {
      const d = map.get(dep);
      if (!d) {
        throw new Error(`Plugin "${p.name}" depends on missing plugin "${dep}"`);
      }
      visit(d, [...stack, p.name]);
    }
    // Optional deps are silently skipped if the plugin is not loaded.
    for (const dep of p.optionalDeps ?? []) {
      const d = map.get(dep);
      if (d) visit(d, [...stack, p.name]);
    }
    visiting.delete(p.name);
    visited.add(p.name);
    order.push(p);
  };

  for (const p of plugins) visit(p, []);
  return order;
}

export async function loadPlugins(
  plugins: Plugin[],
  opts: LoadPluginsOptions,
): Promise<{ loaded: Plugin[]; failed: { plugin: Plugin; err: unknown }[] }> {
  const kernelVersion = opts.kernelApiVersion ?? KERNEL_API_VERSION;
  const loaded: Plugin[] = [];
  const failed: { plugin: Plugin; err: unknown }[] = [];

  // Conflict check
  const names = new Set(plugins.map((p) => p.name));
  for (const p of plugins) {
    for (const c of p.conflictsWith ?? []) {
      if (names.has(c)) {
        throw new Error(`Plugin "${p.name}" conflicts with loaded plugin "${c}"`);
      }
    }
  }

  let sorted: Plugin[];
  try {
    sorted = topoSort(plugins);
  } catch (err) {
    opts.log.error('Plugin sort failed', err);
    throw err;
  }

  for (const plugin of sorted) {
    if (!satisfies(plugin.apiVersion, kernelVersion)) {
      const err = new Error(
        `Plugin "${plugin.name}" requires apiVersion ${plugin.apiVersion}; kernel is ${kernelVersion}`,
      );
      opts.log.error(err.message);
      failed.push({ plugin, err });
      continue;
    }
    try {
      const api = opts.apiFactory(plugin);
      await plugin.setup(api);
      loaded.push(plugin);
      opts.log.info(`Plugin "${plugin.name}" loaded`);
    } catch (err) {
      opts.log.error(`Plugin "${plugin.name}" setup failed`, err);
      failed.push({ plugin, err });
    }
  }
  return { loaded, failed };
}
