import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  color,
  atomicWrite,
  rewriteConfigEncrypted,
  type Config,
  type SecretVault,
  type SessionStore,
  type SkillLoader,
  type ToolRegistry,
  type ModelsRegistry,
  type WstackPaths,
  type WireFamily,
} from '@wrongstack/core';
import type { TerminalRenderer } from '../renderer.js';
import type { ReadlineInputReader } from '../input-reader.js';

export type SubcommandHandler = (args: string[], deps: SubcommandDeps) => Promise<number>;

export interface SubcommandDeps {
  config: Config;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  sessionStore?: SessionStore;
  skillLoader?: SkillLoader;
  toolRegistry?: ToolRegistry;
  modelsRegistry: ModelsRegistry;
  paths: WstackPaths;
  vault: SecretVault;
  cwd: string;
  projectRoot: string;
  userHome: string;
}

export const subcommands: Record<string, SubcommandHandler> = {
  init: initCmd,
  auth: authCmd,
  // `resume <id>` is special-cased in src/index.ts: it's lifted into
  // `--resume <id>` so the normal REPL bootstrap runs with a pre-loaded
  // session. There is no standalone subcommand handler.
  sessions: sessionsCmd,
  config: configCmd,
  tools: toolsCmd,
  skills: skillsCmd,
  providers: providersCmd,
  models: modelsCmd,
  mcp: mcpCmd,
  plugin: pluginCmd,
  diag: diagCmd,
  usage: usageCmd,
  version: versionCmd,
  help: helpCmd,
  projects: projectsCmd,
};

/**
 * Store an API key for a provider in the global config, encrypted at rest.
 * Usage: `wstack auth <providerId> [--family <fam>] [--base-url <url>]`
 *
 * If the provider is in the models.dev catalog, family/baseUrl come from
 * there. For custom providers, pass them via flags — that's the only way
 * to make the system fully offline-capable.
 */
async function authCmd(args: string[], deps: SubcommandDeps): Promise<number> {
  const flags = parseAuthFlags(args);
  let providerId = flags.positional[0];
  if (!providerId) {
    providerId = (await deps.reader.readLine('Provider id: ')).trim();
  }
  if (!providerId) {
    deps.renderer.writeError('Provider id is required.');
    return 1;
  }

  let family: WireFamily | undefined = flags.family;
  let baseUrl: string | undefined = flags.baseUrl;
  let envVars: string[] | undefined = flags.envVars;

  // If catalog knows this provider, use its defaults — but flags still win.
  try {
    const known = await deps.modelsRegistry.getProvider(providerId);
    if (known) {
      if (!family) family = known.family;
      if (!baseUrl) baseUrl = known.apiBase;
      if (!envVars) envVars = known.envVars;
    }
  } catch {
    // catalog unavailable — that's fine, user can pass --family
  }

  if (!family) {
    deps.renderer.writeError(
      `Provider "${providerId}" not in catalog. Pass --family <anthropic|openai|openai-compatible|google> to register it manually.`,
    );
    return 1;
  }

  const apiKey = (
    await deps.reader.readSecret(
      `API key for ${providerId} (hidden, stored encrypted in ${deps.paths.globalConfig}): `,
    )
  ).trim();
  if (!apiKey) {
    deps.renderer.writeError('No key entered. Nothing saved.');
    return 1;
  }

  const patch = {
    providers: {
      [providerId]: {
        type: providerId,
        apiKey,
        family,
        ...(baseUrl ? { baseUrl } : {}),
        ...(envVars && envVars.length > 0 ? { envVars } : {}),
      },
    },
  };
  try {
    await rewriteConfigEncrypted(deps.paths.globalConfig, deps.vault, patch);
    deps.renderer.writeInfo(`Stored encrypted key for ${providerId}.`);
    deps.renderer.writeInfo(`Use: wstack --provider ${providerId} "<task>"`);
    return 0;
  } catch (err) {
    deps.renderer.writeError(`auth: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

interface AuthFlags {
  positional: string[];
  family?: WireFamily;
  baseUrl?: string;
  envVars?: string[];
}

function parseAuthFlags(args: string[]): AuthFlags {
  const out: AuthFlags = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--family') {
      const v = args[++i];
      if (v) out.family = v as WireFamily;
    } else if (a === '--base-url') {
      const v = args[++i];
      if (v) out.baseUrl = v;
    } else if (a === '--env') {
      const v = args[++i];
      if (v) out.envVars = v.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a && !a.startsWith('--')) {
      out.positional.push(a);
    }
  }
  return out;
}

async function initCmd(_args: string[], deps: SubcommandDeps): Promise<number> {
  deps.renderer.write(color.bold('WrongStack init\n'));
  deps.renderer.writeInfo('Loading provider catalog from models.dev (cached locally)…');

  let providers;
  try {
    providers = await deps.modelsRegistry.listProviders();
  } catch (err) {
    deps.renderer.writeError(
      `Failed to load provider catalog: ${err instanceof Error ? err.message : err}`,
    );
    return 1;
  }

  // Prefer providers whose env var is already set, then anthropic/openai/google as common defaults.
  const detected = providers
    .filter((p) => p.family !== 'unsupported')
    .filter((p) => p.envVars.some((v) => process.env[v]));
  const ranked =
    detected.length > 0
      ? detected
      : providers.filter((p) => ['anthropic', 'openai', 'google'].includes(p.id));

  if (detected.length > 0) {
    deps.renderer.write(`Detected API keys for: ${detected.map((p) => p.name).join(', ')}\n`);
  }

  const defaultId = ranked[0]?.id ?? 'anthropic';
  const providerId =
    (await deps.reader.readLine(`Provider [${defaultId}]: `)).trim() || defaultId;

  const provider = await deps.modelsRegistry.getProvider(providerId);
  if (!provider) {
    deps.renderer.writeError(`Provider "${providerId}" not found in models.dev catalog.`);
    return 1;
  }
  if (provider.family === 'unsupported') {
    deps.renderer.writeError(
      `Provider "${providerId}" uses ${provider.npm} which has no built-in transport. Install a plugin to enable it.`,
    );
    return 1;
  }

  const suggestedModel = (await deps.modelsRegistry.suggestModel(providerId)) ?? '';
  const modelHint = suggestedModel ? ` [${suggestedModel}]` : '';
  const modelId =
    (await deps.reader.readLine(`Model${modelHint}: `)).trim() || suggestedModel;
  if (!modelId) {
    deps.renderer.writeError('No model selected. Aborting.');
    return 1;
  }

  // Find any existing env value
  const envHit = provider.envVars.map((v) => process.env[v]).find(Boolean);
  let apiKey = '';
  if (!envHit) {
    apiKey = (
      await deps.reader.readLine(
        `API key (stored in ${deps.paths.globalConfig}; empty = expect ${provider.envVars[0] ?? 'env var'}): `,
      )
    ).trim();
  } else {
    deps.renderer.writeInfo(`Found API key in env (${provider.envVars.join(' / ')}).`);
  }

  await fs.mkdir(deps.paths.globalRoot, { recursive: true });
  const config: Partial<Config> = {
    version: 1,
    provider: providerId,
    model: modelId,
  };
  if (apiKey) config.apiKey = apiKey;
  await atomicWrite(deps.paths.globalConfig, JSON.stringify(config, null, 2));

  // Project-local committed marker (opt-in)
  await fs.mkdir(path.join(deps.projectRoot, '.wrongstack'), { recursive: true });
  const agentsFile = path.join(deps.projectRoot, '.wrongstack', 'AGENTS.md');
  try {
    await fs.access(agentsFile);
  } catch {
    await atomicWrite(
      agentsFile,
      '# Project notes for WrongStack\n\nWrite project-specific conventions, build commands,\nand domain knowledge here. This file is committed to git.\n',
    );
  }

  deps.renderer.writeInfo(`Wrote ${deps.paths.globalConfig}`);
  deps.renderer.writeInfo(`Project state lives in ${deps.paths.projectDir}`);
  deps.renderer.writeInfo('Try: wstack "<task>"  or  wstack');
  return 0;
}

async function sessionsCmd(_args: string[], deps: SubcommandDeps): Promise<number> {
  if (!deps.sessionStore) {
    deps.renderer.writeError('No session store available.');
    return 1;
  }
  const list = await deps.sessionStore.list(20);
  if (list.length === 0) {
    deps.renderer.write('No sessions found.\n');
    return 0;
  }
  for (const s of list) {
    deps.renderer.write(
      `  ${s.id}  ${color.dim(s.startedAt)}  ${color.dim(`${s.tokenTotal} tok`)}  ${s.title}\n`,
    );
  }
  return 0;
}

async function configCmd(args: string[], deps: SubcommandDeps): Promise<number> {
  const sub = args[0];
  if (!sub || sub === 'show') {
    const redacted = redactKeys(deps.config);
    deps.renderer.write(JSON.stringify(redacted, null, 2) + '\n');
    return 0;
  }
  if (sub === 'edit') {
    const editor = process.env['EDITOR'] ?? 'vi';
    deps.renderer.write(`Run: ${editor} ${deps.paths.globalConfig}\n`);
    return 0;
  }
  deps.renderer.writeError(`Unknown config subcommand: ${sub}`);
  return 1;
}

async function toolsCmd(_args: string[], deps: SubcommandDeps): Promise<number> {
  const reg = deps.toolRegistry;
  if (!reg) return 0;
  for (const { tool, owner } of reg.listWithOwner()) {
    deps.renderer.write(
      `  ${tool.name.padEnd(28)} ${color.dim(`[${owner}]`)} ${tool.permission}\n`,
    );
  }
  return 0;
}

async function skillsCmd(_args: string[], deps: SubcommandDeps): Promise<number> {
  if (!deps.skillLoader) return 0;
  const list = await deps.skillLoader.list();
  for (const s of list) {
    deps.renderer.write(
      `  ${s.name.padEnd(24)} ${color.dim(`[${s.source}]`)} ${s.description.split('\n')[0]}\n`,
    );
  }
  return 0;
}

async function providersCmd(args: string[], deps: SubcommandDeps): Promise<number> {
  const showAll = args.includes('--all');
  const showUnsupported = args.includes('--unsupported');
  try {
    const all = await deps.modelsRegistry.listProviders();
    const byFamily: Record<WireFamily, typeof all> = {
      anthropic: [],
      openai: [],
      'openai-compatible': [],
      google: [],
      unsupported: [],
    };
    for (const p of all) byFamily[p.family].push(p);

    const families: WireFamily[] = showUnsupported
      ? ['unsupported']
      : showAll
        ? ['anthropic', 'openai', 'google', 'openai-compatible', 'unsupported']
        : ['anthropic', 'openai', 'google', 'openai-compatible'];

    for (const family of families) {
      const list = byFamily[family];
      if (list.length === 0) continue;
      deps.renderer.write(`\n${color.bold(family)} (${list.length}):\n`);
      for (const p of list) {
        const envFound = p.envVars.some((v) => process.env[v]);
        const marker = envFound ? color.green('●') : color.dim('○');
        const envHint = p.envVars[0] ? color.dim(`[${p.envVars[0]}]`) : '';
        const note = family === 'unsupported' ? color.dim('(needs plugin)') : '';
        deps.renderer.write(
          `  ${marker} ${p.id.padEnd(20)} ${p.name.padEnd(28)} ${envHint} ${note}\n`,
        );
      }
    }
    deps.renderer.write(
      `\n${color.dim(`Current: ${deps.config.provider ?? '<unset>'} / ${deps.config.model ?? '<unset>'}. Use --all to include unsupported families.`)}\n`,
    );
    return 0;
  } catch (err) {
    deps.renderer.writeError(
      `Failed to list providers: ${err instanceof Error ? err.message : err}`,
    );
    return 1;
  }
}

async function modelsCmd(args: string[], deps: SubcommandDeps): Promise<number> {
  const sub = args[0];
  if (sub === 'refresh') {
    deps.renderer.writeInfo('Refreshing models.dev cache…');
    try {
      const payload = await deps.modelsRegistry.refresh();
      deps.renderer.writeInfo(
        `Cached ${Object.keys(payload).length} providers to ${deps.paths.modelsCache}`,
      );
      return 0;
    } catch (err) {
      deps.renderer.writeError(`Refresh failed: ${err instanceof Error ? err.message : err}`);
      return 1;
    }
  }
  const providerId = sub ?? deps.config.provider;
  if (!providerId) {
    deps.renderer.writeError('Usage: wstack models <provider> | refresh');
    return 1;
  }
  const provider = await deps.modelsRegistry.getProvider(providerId);
  if (!provider) {
    deps.renderer.writeError(`Provider "${providerId}" not in catalog.`);
    return 1;
  }
  deps.renderer.write(`${color.bold(provider.name)} ${color.dim(`(${provider.id})`)}\n`);
  if (provider.doc) deps.renderer.write(color.dim(`Docs: ${provider.doc}\n`));
  const sorted = [...provider.models].sort((a, b) =>
    (b.release_date ?? '').localeCompare(a.release_date ?? ''),
  );
  for (const m of sorted) {
    const caps: string[] = [];
    if (m.tool_call) caps.push('tools');
    if (m.reasoning) caps.push('reasoning');
    if (m.modalities?.input?.includes('image')) caps.push('vision');
    const ctx = m.limit?.context ? `${(m.limit.context / 1000).toFixed(0)}k` : '?';
    const cost = m.cost?.input !== undefined ? `$${m.cost.input}/$${m.cost.output ?? '?'}` : '';
    deps.renderer.write(
      `  ${m.id.padEnd(40)} ${color.dim(ctx.padStart(6))}  ${color.dim(cost.padEnd(14))} ${color.dim(caps.join(','))}\n`,
    );
  }
  const age = await deps.modelsRegistry.ageSeconds();
  deps.renderer.write(
    color.dim(
      `\nCache age: ${isFinite(age) ? `${Math.round(age / 60)}m` : 'never fetched'}. Run \`wstack models refresh\` to update.\n`,
    ),
  );
  return 0;
}

async function mcpCmd(args: string[], deps: SubcommandDeps): Promise<number> {
  const sub = args[0];
  if (!sub || sub === 'list') {
    const servers = deps.config.mcpServers ?? {};
    if (Object.keys(servers).length === 0) {
      deps.renderer.write('No MCP servers configured.\n');
      return 0;
    }
    for (const [name, cfg] of Object.entries(servers)) {
      deps.renderer.write(
        `  ${name.padEnd(20)} ${cfg.transport}  ${cfg.enabled === false ? 'disabled' : 'enabled'}\n`,
      );
    }
    return 0;
  }
  if (sub === 'restart') {
    deps.renderer.writeWarning('mcp restart is only available in REPL mode.');
    return 0;
  }
  deps.renderer.writeError(`Unknown mcp subcommand: ${sub}`);
  return 1;
}

async function pluginCmd(args: string[], deps: SubcommandDeps): Promise<number> {
  const sub = args[0];
  if (!sub || sub === 'list') {
    const plugins = deps.config.plugins ?? [];
    if (plugins.length === 0) {
      deps.renderer.write('No plugins configured.\n');
      return 0;
    }
    for (const p of plugins) {
      const name = typeof p === 'string' ? p : p.name;
      const enabled = typeof p === 'object' && p.enabled === false ? 'disabled' : 'enabled';
      deps.renderer.write(`  ${name}  ${enabled}\n`);
    }
    return 0;
  }
  deps.renderer.writeWarning(`plugin ${sub} not implemented (edit config.plugins manually).`);
  return 0;
}

async function diagCmd(_args: string[], deps: SubcommandDeps): Promise<number> {
  const cfg = deps.config;
  const age = await deps.modelsRegistry.ageSeconds();
  const lines = [
    color.bold('WrongStack diagnostics'),
    `  apiVersion:    0.0.1`,
    `  cwd:           ${deps.cwd}`,
    `  projectRoot:   ${deps.projectRoot}`,
    `  projectHash:   ${deps.paths.projectHash}`,
    `  projectDir:    ${deps.paths.projectDir}`,
    `  globalRoot:    ${deps.paths.globalRoot}`,
    `  modelsCache:   ${deps.paths.modelsCache}`,
    `  cacheAge:      ${isFinite(age) ? `${Math.round(age / 60)}m` : 'never'}`,
    `  node:          ${process.version}`,
    `  os:            ${os.platform()} ${os.release()}`,
    `  provider:      ${cfg.provider ?? '<unset>'}`,
    `  model:         ${cfg.model ?? '<unset>'}`,
    `  tools:         ${deps.toolRegistry?.list().length ?? 0}`,
    `  plugins:       ${cfg.plugins?.length ?? 0}`,
    `  mcpServers:    ${Object.keys(cfg.mcpServers ?? {}).length}`,
  ];
  deps.renderer.write(lines.join('\n') + '\n');
  return 0;
}

async function usageCmd(_args: string[], deps: SubcommandDeps): Promise<number> {
  if (!deps.sessionStore) return 0;
  const list = await deps.sessionStore.list(100);
  let totalIn = 0;
  for (const s of list) totalIn += s.tokenTotal;
  deps.renderer.write(`Sessions: ${list.length}  total tokens: ${totalIn}\n`);
  return 0;
}

async function versionCmd(_args: string[], deps: SubcommandDeps): Promise<number> {
  deps.renderer.write(
    `WrongStack 0.0.1 (apiVersion 0.0.1, node ${process.version}, ${os.platform()})\n`,
  );
  return 0;
}

async function helpCmd(_args: string[], deps: SubcommandDeps): Promise<number> {
  const lines = [
    color.bold('WrongStack — usage'),
    '',
    '  wstack                       Start REPL',
    '  wstack "<task>"              Run task and exit',
    '  wstack resume [<id>]         Resume a session',
    '  wstack sessions              List recent sessions',
    '  wstack init                  Pick provider + model from models.dev',
    '  wstack auth <provider>       Store API key (encrypted at rest)',
    '  wstack resume <id>           Resume a session (loads transcript + appends)',
    '  wstack config [show|edit]    Show or edit effective config',
    '  wstack tools                 List registered tools',
    '  wstack skills                List discovered skills',
    '  wstack providers [--all]     List providers from models.dev',
    '  wstack models [<provider>]   List models for current/specified provider',
    '  wstack models refresh        Force-refresh models.dev cache',
    '  wstack mcp [list]            List MCP servers',
    '  wstack plugin [list]         List plugins',
    '  wstack projects              List projects tracked in ~/.wrongstack/projects/',
    '  wstack diag                  Full diagnostics',
    '  wstack usage                 Token + cost summary',
    '  wstack version               Print version',
    '',
    'Global flags:',
    '  --provider, --model, --cwd, --log-level, --yolo, --verbose, --trace, --config',
  ];
  deps.renderer.write(lines.join('\n') + '\n');
  return 0;
}

async function projectsCmd(_args: string[], deps: SubcommandDeps): Promise<number> {
  const projectsRoot = path.join(deps.paths.globalRoot, 'projects');
  try {
    const entries = await fs.readdir(projectsRoot);
    if (entries.length === 0) {
      deps.renderer.write('No projects tracked.\n');
      return 0;
    }
    for (const hash of entries) {
      try {
        const meta = JSON.parse(
          await fs.readFile(path.join(projectsRoot, hash, 'meta.json'), 'utf8'),
        ) as { root?: string; lastSeen?: string };
        deps.renderer.write(
          `  ${color.dim(hash)}  ${color.dim(meta.lastSeen ?? '')}  ${meta.root ?? '?'}\n`,
        );
      } catch {
        deps.renderer.write(`  ${color.dim(hash)}  ${color.dim('(no meta)')}\n`);
      }
    }
    return 0;
  } catch {
    deps.renderer.write('No projects directory.\n');
    return 0;
  }
}

function redactKeys(obj: unknown): unknown {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactKeys);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (/api.?key|secret|token|pass/i.test(k) && typeof v === 'string' && v.length > 0) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redactKeys(v);
    }
  }
  return out;
}
