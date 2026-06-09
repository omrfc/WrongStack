import { PluginError, ERROR_CODES } from '../types/errors.js';
import type { Logger } from '../types/logger.js';
import type { Plugin, PluginAPI, PluginDependency } from '../types/plugin.js';
import { validateAgainstSchema } from '../utils/json-schema-validate.js';

/** Internal map tracking the API instance each plugin received during setup,
 *  so unloadPlugins can call teardown with the same API (not a fresh one).
 *  Using a WeakMap avoids pinning plugins in memory after teardown. */
const pluginApiMap = new WeakMap<Plugin, PluginAPI>();

/**
 * Stable plugin API contract version. This is intentionally independent of
 * the package version: bump only when the surface visible to plugins
 * (PluginAPI, types/plugin) changes in a way that breaks existing setup
 * functions. Plugins declare `apiVersion: "^1.0"` to opt into this contract.
 *
 * 0.1.9: additive — `FleetSpawnBudgetError|FleetCostCapError` plus `FLEET_ROSTER` and the
 * pre-built fleet agent configs (Audit Log, Bug Hunter, Refactor Planner,
 * Security Scanner) now exported from `@wrongstack/core`.
 * 0.1.10: additive — extended-thinking stream events, core subpath
 * exports, tool output size chips on `tool.executed`. Plugin contract
 * unchanged otherwise; 0.1.x range still loads cleanly.
 *
 * Note: the package shipped as 0.2.0, but the *plugin contract* didn't
 * change in a breaking way — `SubagentError`, `subagent.tool_executed`,
 * `transcriptPath`, `planTool`, `delegate`, `runText`, and Director
 * sessionWriter are all additive to the surface. We deliberately keep
 * the kernel API at 0.1.10 so plugins pinning `apiVersion: "^0.1"`
 * keep loading. Bump to 1.0 when we stabilize and want the freedom to
 * remove deprecated surfaces.
 */
export const KERNEL_API_VERSION = '0.1.10';

export interface LoadPluginsOptions {
  apiFactory: (plugin: Plugin) => PluginAPI;
  log: Logger;
  kernelApiVersion?: string | undefined;
  /**
   * Per-plugin options keyed by plugin name. When a plugin declares
   * `configSchema`, the loader validates `pluginOptions[plugin.name]`
   * against it before calling `setup`. Pass `Config.plugins` shaped
   * `{ [name]: { options } }` or any flat record.
   */
  pluginOptions?: Record<string, unknown>;
  /**
   * When true, the loader throws a PluginError if a plugin calls an API
   * method that contradicts its declared `capabilities` — instead of
   * just logging a warning. Use in CI/strict deployments to enforce
   * manifest honesty. Default: false (log-only, backward-compatible).
   */
  enforceCapabilities?: boolean | undefined;
}

function parseSemver(v: string): [number, number, number] {
  const parts = v
    .replace(/^[^0-9]*/, '')
    .split('.')
    .map((s) => Number.parseInt(s, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function satisfies(range: string, version: string): boolean {
  const [vMaj, vMin, vPatch] = parseSemver(version);
  const trimmed = range.trim();
  const op = trimmed.startsWith('^') ? '^' : trimmed.startsWith('~') ? '~' : '=';
  const ver = trimmed.replace(/^[\^~=]/, '');
  const [rMaj, rMin, rPatch] = parseSemver(ver);
  if (op === '^') {
    if (rMaj === 0) return vMaj === 0 && vMin === rMin && vPatch >= rPatch;
    return vMaj === rMaj && (vMin > rMin || (vMin === rMin && vPatch >= rPatch));
  }
  if (op === '~') {
    return vMaj === rMaj && vMin === rMin && vPatch >= rPatch;
  }
  return vMaj === rMaj && vMin === rMin && vPatch === rPatch;
}

/** Normalize either `string` or `PluginDependency` into the structured form. */
function normalizeDep(d: string | PluginDependency): PluginDependency {
  return typeof d === 'string' ? { name: d } : d;
}

/**
 * Shallow-merge defaults with overrides. Override keys take precedence;
 * defaults fill in where overrides are missing. Nested objects are
 * NOT deep-merged — the override value replaces wholesale.
 */
function shallowMerge(
  defaults: Record<string, unknown>,
  overrides: unknown,
): Record<string, unknown> {
  if (overrides === undefined || overrides === null) return { ...defaults };
  if (typeof overrides !== 'object') return { ...defaults };
  const ov = overrides as Record<string, unknown>;
  const out: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(ov)) {
    out[key] = ov[key];
  }
  return out;
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
      throw new PluginError({
        message: `Plugin dependency cycle: ${[...stack, p.name].join(' -> ')}`,
        code: ERROR_CODES.PLUGIN_LOAD_FAILED,
        pluginName: p.name,
      });
    }
    visiting.add(p.name);
    for (const raw of p.dependsOn ?? []) {
      const dep = normalizeDep(raw);
      const d = map.get(dep.name);
      if (!d) {
        throw new PluginError({
          message: `Plugin "${p.name}" depends on missing plugin "${dep.name}"`,
          code: ERROR_CODES.PLUGIN_MISSING_DEPENDENCY,
          pluginName: p.name,
          context: { dependency: dep.name },
        });
      }
      // Version constraint check — only when both declared range and the
      // dependency's actual version are available. Missing either side is
      // tolerated: plugins without `version` are treated as wildcard.
      if (dep.version && d.version && !satisfies(dep.version, d.version)) {
        throw new PluginError({
          message: `Plugin "${p.name}" requires "${dep.name}@${dep.version}", found ${d.version}`,
          code: ERROR_CODES.PLUGIN_LOAD_FAILED,
          pluginName: p.name,
          context: { dependency: dep.name, required: dep.version, found: d.version },
        });
      }
      visit(d, [...stack, p.name]);
    }
    // Optional deps are silently skipped if the plugin is not loaded.
    for (const raw of p.optionalDeps ?? []) {
      const dep = normalizeDep(raw);
      const d = map.get(dep.name);
      if (d) {
        if (dep.version && d.version && !satisfies(dep.version, d.version)) {
          throw new PluginError({
            message: `Plugin "${p.name}" optional dep "${dep.name}@${dep.version}" found ${d.version}`,
            code: ERROR_CODES.PLUGIN_LOAD_FAILED,
            pluginName: p.name,
            context: { dependency: dep.name, required: dep.version, found: d.version },
          });
        }
        visit(d, [...stack, p.name]);
      }
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
        throw new PluginError({
          message: `Plugin "${p.name}" conflicts with loaded plugin "${c}"`,
          code: ERROR_CODES.PLUGIN_LOAD_FAILED,
          pluginName: p.name,
          context: { conflictsWith: c },
        });
      }
    }
  }

  let sorted: Plugin[];
  try {
    sorted = topoSort(plugins);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.log.error('Plugin dependency sort failed', message);
    throw new PluginError({
      message: `Plugin dependency sort failed: ${message}`,
      code: ERROR_CODES.PLUGIN_LOAD_FAILED,
      pluginName: '(topological sort)',
      context: { pluginCount: plugins.length },
      cause: err,
    });
  }

  for (const plugin of sorted) {
    if (!satisfies(plugin.apiVersion, kernelVersion)) {
      const err = new PluginError({
        message: `Plugin "${plugin.name}" requires apiVersion ${plugin.apiVersion}; kernel is ${kernelVersion}`,
        code: ERROR_CODES.PLUGIN_API_MISMATCH,
        pluginName: plugin.name,
        context: { required: plugin.apiVersion, kernel: kernelVersion },
      });
      opts.log.error(err.message);
      failed.push({ plugin, err });
      continue;
    }
    // Merge defaultConfig (plugin defaults) with user-provided pluginOptions.
    // User values take precedence over plugin defaults. The merged result
    // is fed to configSchema validation and eventually to setup().
    if (plugin.defaultConfig && opts.pluginOptions) {
      const userOpts = opts.pluginOptions[plugin.name];
      const merged = shallowMerge(plugin.defaultConfig, userOpts);
      opts.pluginOptions[plugin.name] = merged;
    }

    // configSchema validation — runs before setup() so a bad config never
    // reaches plugin code. The plugin's options are looked up by plugin name
    // in the host-supplied options bag.
    if (plugin.configSchema && opts.pluginOptions) {
      const pluginOpts = opts.pluginOptions[plugin.name];
      if (pluginOpts !== undefined) {
        const result = validateAgainstSchema(pluginOpts, plugin.configSchema);
        if (!result.ok) {
          const firstErr = result.errors[0];
          const detail = firstErr ? `${firstErr.path}: ${firstErr.message}` : 'config invalid';
          const err = new PluginError({
            message: `Plugin "${plugin.name}" config invalid — ${detail}`,
            code: ERROR_CODES.PLUGIN_LOAD_FAILED,
            pluginName: plugin.name,
            context: { errors: result.errors },
          });
          opts.log.error(err.message);
          failed.push({ plugin, err });
          continue;
        }
      }
    }
    try {
      const rawApi = opts.apiFactory(plugin);
      const api = plugin.capabilities
        ? wrapApiForCapabilityCheck(plugin, rawApi, opts.log, opts.enforceCapabilities)
        : rawApi;
      await plugin.setup(api);
      pluginApiMap.set(plugin, api);
      loaded.push(plugin);
      opts.log.info(`Plugin "${plugin.name}" loaded`);
    } catch (err) {
      opts.log.error(`Plugin "${plugin.name}" setup failed`, err);
      failed.push({ plugin, err });
    }
  }
  return { loaded, failed };
}

/**
 * Tear down loaded plugins in reverse-dependency order. `teardown()` is
 * best-effort: errors are caught and logged so a single misbehaving plugin
 * can't abort the host shutdown sequence.
 *
 * Pass the result of a prior `loadPlugins(...)` call's `loaded` array, plus
 * the original `LoadPluginsOptions` so the same `apiFactory` (and the same
 * PluginAPI surface the plugin saw during `setup`) is used for `teardown`.
 */
export async function unloadPlugins(
  loadedPlugins: Plugin[],
  opts: LoadPluginsOptions,
): Promise<void> {
  // Reverse order — last loaded is first torn down, mirroring stack-style
  // resource ownership when plugin B depends on plugin A.
  const ordered = [...loadedPlugins].reverse();
  for (const plugin of ordered) {
    if (typeof plugin.teardown !== 'function') continue;
    try {
      // Use the same API instance the plugin received during setup,
      // so its accumulated cleanup functions are properly drained.
      // The plugin MUST be in pluginApiMap since it was registered there
      // during loadPlugins — if it is missing, that is a programming error.
      const api = pluginApiMap.get(plugin);
      if (!api) {
        throw new Error(
          `Plugin "${plugin.name}" API not found in pluginApiMap — was setup() called?`,
        );
      }
      await plugin.teardown(api);
      pluginApiMap.delete(plugin);
      opts.log.info(`Plugin "${plugin.name}" torn down`);
    } catch (err) {
      opts.log.error(`Plugin "${plugin.name}" teardown failed`, err);
    }
  }
}

/**
 * Wrap the PluginAPI so calls that contradict the plugin's declared
 * capabilities are caught. By default violations are logged as warnings
 * (backward-compatible). When `enforce` is true, violations throw a
 * PluginError so the host can reject misbehaving plugins at setup time.
 */
function wrapApiForCapabilityCheck(
  plugin: Plugin,
  api: PluginAPI,
  log: {
    error(msg: string, ctx?: unknown): void | undefined;
    warn?(msg: string, ctx?: unknown): void | undefined;
    info?(msg: string, ctx?: unknown): void | undefined;
  },
  enforce = false,
): PluginAPI {
  const caps = plugin.capabilities ?? {};
  const violate = (subsystem: string, detail: string) => {
    const msg = `Plugin "${plugin.name}" used ${subsystem} without declaring capabilities.${subsystem} — ${detail}`;
    if (enforce) {
      throw new PluginError({
        message: msg,
        code: ERROR_CODES.PLUGIN_LOAD_FAILED,
        pluginName: plugin.name,
        context: { subsystem, detail },
      });
    }
    if (typeof log.warn === 'function') log.warn(msg);
    else log.error(msg);
  };

  // Wrap tools.register
  const wrappedTools =
    caps.tools !== false
      ? api.tools
      : new Proxy(api.tools, {
          get(target, prop, receiver) {
            if (prop === 'register') {
              return (t: unknown) => {
                violate('tools', `register(${(t as { name?: string | undefined })?.name ?? '<unknown>'})`);
                return (target.register as (x: unknown) => unknown)(t);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
  // Wrap providers.register
  const wrappedProviders =
    caps.providers !== false
      ? api.providers
      : new Proxy(api.providers, {
          get(target, prop, receiver) {
            if (prop === 'register') {
              return (f: unknown) => {
                violate('providers', `register(${(f as { type?: string | undefined })?.type ?? '<unknown>'})`);
                return (target.register as (x: unknown) => unknown)(f);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
  // Wrap slashCommands.register
  const wrappedSlash =
    caps.slashCommands !== false
      ? api.slashCommands
      : new Proxy(api.slashCommands, {
          get(target, prop, receiver) {
            if (prop === 'register') {
              return (c: unknown) => {
                violate(
                  'slashCommands',
                  `register(${(c as { name?: string | undefined })?.name ?? '<unknown>'})`,
                );
                return (target.register as (x: unknown) => unknown)(c);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
  // Wrap mcp.start
  const wrappedMcp =
    caps.mcp !== false
      ? api.mcp
      : new Proxy(api.mcp, {
          get(target, prop, receiver) {
            if (prop === 'start') {
              return (cfg: unknown) => {
                violate('mcp', `start(${(cfg as { name?: string | undefined })?.name ?? '<unknown>'})`);
                return (target.start as (x: unknown) => unknown)(cfg);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });

  return new Proxy(api, {
    get(target, prop, receiver) {
      switch (prop) {
        case 'tools':
          return wrappedTools;
        case 'providers':
          return wrappedProviders;
        case 'slashCommands':
          return wrappedSlash;
        case 'mcp':
          return wrappedMcp;
        default:
          return Reflect.get(target, prop, receiver);
      }
    },
  });
}
