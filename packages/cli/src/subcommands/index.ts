import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  color,
  atomicWrite,
  DefaultSessionReader,
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
import { CLI_VERSION, API_VERSION } from '../version.js';
import { runAuthMenu, runAuthDirect } from '../auth-menu.js';

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
  doctor: doctorCmd,
  export: exportCmd,
  usage: usageCmd,
  version: versionCmd,
  help: helpCmd,
  projects: projectsCmd,
};

/**
 * Manage API keys.
 *
 * - `wstack auth` (no args) opens the interactive manager: list saved
 *   providers, add/update/delete keys, set the active key per provider,
 *   or pick a new provider from the models.dev catalog.
 * - `wstack auth <providerId> [--label <l>] [--family <f>] [--base-url <u>] [--env <a,b>]`
 *   is the scripted one-shot: prompt for a single key and append it
 *   under `<l>` (default "default", auto-suffixed on collision).
 *
 * Keys are stored under `providers[<id>].apiKeys[]`, encrypted at rest
 * by the secret vault. The legacy single-key `apiKey` field is still
 * honored for reads and is kept in sync with the active entry.
 */
async function authCmd(args: string[], deps: SubcommandDeps): Promise<number> {
  const flags = parseAuthFlags(args);
  const menuDeps = {
    renderer: deps.renderer,
    reader: deps.reader,
    modelsRegistry: deps.modelsRegistry,
    vault: deps.vault,
    globalConfigPath: deps.paths.globalConfig,
  };

  if (flags.positional.length === 0) {
    return runAuthMenu(menuDeps);
  }

  return runAuthDirect(menuDeps, {
    providerId: flags.positional[0]!,
    label: flags.label,
    family: flags.family,
    baseUrl: flags.baseUrl,
    envVars: flags.envVars,
  });
}

interface AuthFlags {
  positional: string[];
  label?: string;
  family?: WireFamily;
  baseUrl?: string;
  envVars?: string[];
}

function parseAuthFlags(args: string[]): AuthFlags {
  const out: AuthFlags = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--label') {
      const v = args[++i];
      if (v) out.label = v;
    } else if (a === '--family') {
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
  // If the requested id is an alias (`providers[id].type` points at a
  // different catalog entry), fall back to that catalog id so the user
  // still gets the model list.
  let lookupId = providerId;
  const savedAlias = deps.config.providers?.[providerId];
  if (savedAlias?.type && savedAlias.type !== providerId) {
    lookupId = savedAlias.type;
  }
  const provider = await deps.modelsRegistry.getProvider(lookupId);
  if (!provider) {
    deps.renderer.writeError(
      lookupId !== providerId
        ? `Alias "${providerId}" points at catalog id "${lookupId}" which is not in the cache.`
        : `Provider "${providerId}" not in catalog.`,
    );
    return 1;
  }
  if (lookupId !== providerId) {
    deps.renderer.write(color.dim(`(showing catalog models for "${lookupId}" via alias "${providerId}")\n`));
  }
  deps.renderer.write(`${color.bold(provider.name)} ${color.dim(`(${provider.id})`)}\n`);
  if (provider.doc) deps.renderer.write(color.dim(`Docs: ${provider.doc}\n`));
  // User-saved model list wins when present — `wstack models <id>` should
  // reflect what the user has configured for that endpoint, not what
  // models.dev thinks is on offer (e.g. LM Studio with custom model ids).
  // When a user model id ALSO exists in the catalog we surface the
  // catalog metadata (ctx/cost/caps); otherwise we just print the id.
  const userModels = deps.config.providers?.[providerId]?.models;
  const catalogById = new Map(provider.models.map((m) => [m.id, m]));
  const sorted = userModels && userModels.length > 0
    ? userModels.map((id) => catalogById.get(id) ?? { id, name: id })
    : [...provider.models].sort((a, b) =>
        (b.release_date ?? '').localeCompare(a.release_date ?? ''),
      );
  if (userModels && userModels.length > 0) {
    deps.renderer.write(color.dim(`(${userModels.length} model(s) from your saved config)\n`));
  }
  for (const m of sorted) {
    const caps: string[] = [];
    if ('tool_call' in m && m.tool_call) caps.push('tools');
    if ('reasoning' in m && m.reasoning) caps.push('reasoning');
    if ('modalities' in m && m.modalities?.input?.includes('image')) caps.push('vision');
    const ctx = 'limit' in m && m.limit?.context
      ? `${(m.limit.context / 1000).toFixed(0)}k`
      : '?';
    const cost = 'cost' in m && m.cost?.input !== undefined
      ? `$${m.cost.input}/$${m.cost.output ?? '?'}`
      : '';
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
      deps.renderer.write('Use `wstack mcp add <name>` or set mcpServers in your config.\n');
      return 0;
    }
    for (const [name, cfg] of Object.entries(servers)) {
      const status = cfg.enabled === false ? 'disabled' : 'enabled';
      const desc = cfg.description ? `  # ${cfg.description}` : '';
      deps.renderer.write(
        `  ${name.padEnd(20)} ${cfg.transport.padEnd(16)} ${status}${desc}\n`,
      );
    }
    return 0;
  }

  if (sub === 'add') {
    const name = args[1];
    if (!name) {
      deps.renderer.writeError('Usage: wstack mcp add <name>\n');
      deps.renderer.write('Available servers:\n');
      for (const [sname, scfg] of Object.entries(deps.config.mcpServers ?? {})) {
        deps.renderer.write(`  ${sname.padEnd(20)} ${scfg.description ?? scfg.transport}\n`);
      }
      if (Object.keys(deps.config.mcpServers ?? {}).length === 0) {
        deps.renderer.write(
          '  filesystem       filesystem (read/write/navigate)\n' +
          '  github           github (issues, PRs, repos)\n' +
          '  context7         context7 (codebase docs & Q&A)\n' +
          '  brave-search     brave search (web search)\n' +
          '  block            block (Postgres via SQL)\n' +
          '  everart          everart (AI image generation)\n' +
          '  slack            slack (messaging & channels)\n' +
          '  aws              aws (EC2, S3, Lambda, IAM)\n' +
          '  google-maps      google-maps (directions, geocoding)\n' +
          '  sentinel         sentinel (security vulnerabilities)\n',
        );
      }
      deps.renderer.write('\nRun `wstack mcp add <name> --enable` to enable immediately.\n');
      return 1;
    }
    return addMcpServer(args, deps);
  }

  if (sub === 'remove') {
    const name = args[1];
    if (!name) {
      deps.renderer.writeError('Usage: wstack mcp remove <name>\n');
      return 1;
    }
    return removeMcpServer(name, deps);
  }

  if (sub === 'restart') {
    deps.renderer.writeWarning('mcp restart is only available in REPL mode.');
    return 0;
  }
  deps.renderer.writeError(`Unknown mcp subcommand: ${sub}`);
  return 1;
}

async function addMcpServer(args: string[], deps: SubcommandDeps): Promise<number> {
  const name = args[1]!;
  const enable = args.includes('--enable') || args.includes('-e');

  /** Built-in server presets — all start disabled unless --enable is passed. */
  const builtIn: Record<string, { name: string; transport: 'stdio' | 'sse' | 'streamable-http'; command?: string; args?: string[]; url?: string; env?: Record<string, string>; permission: 'auto' | 'confirm' | 'deny'; description: string; enabled?: boolean }> = {
    filesystem: { name: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'], permission: 'confirm', description: 'Read, write, and navigate the local filesystem' },
    github: { name: 'github', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], permission: 'confirm', description: 'GitHub API — issues, PRs, repos, search' },
    'context7': { name: 'context7', transport: 'streamable-http', url: 'https://server.context7.ai/mcp', permission: 'confirm', description: 'Codebase-aware documentation and Q&A' },
    'brave-search': { name: 'brave-search', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], permission: 'confirm', description: 'Web search (Brave)' },
    block: { name: 'block', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-block'], permission: 'confirm', description: 'Postgres database via SQL' },
    everart: { name: 'everart', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everart'], permission: 'confirm', description: 'AI image generation' },
    slack: { name: 'slack', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'], permission: 'confirm', description: 'Slack messaging & channels' },
    aws: { name: 'aws', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-aws'], permission: 'confirm', description: 'AWS — EC2, S3, Lambda, IAM' },
    'google-maps': { name: 'google-maps', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-google-maps'], permission: 'confirm', description: 'Google Maps — directions, geocoding, places' },
    sentinel: { name: 'sentinel', transport: 'streamable-http', url: 'https://mcp.sentinel.ai', permission: 'deny', description: 'Security vulnerability scanning' },
  };

  const factory = builtIn[name] as typeof builtIn[string] | undefined;
  if (!factory) {
    deps.renderer.writeError(`Unknown server "${name}". Run \`wstack mcp add\` without args to see available servers.\n`);
    return 1;
  }

  const serverCfg = { ...factory };
  if (!enable) serverCfg.enabled = false;

  // Load and update the config file
  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(deps.paths.globalConfig, 'utf8');
    existing = JSON.parse(raw);
  } catch {
    // Config doesn't exist yet — that's fine
  }

  const mcpServers = (existing.mcpServers as Record<string, Record<string, unknown>> | undefined) ?? {};
  if (mcpServers[name]) {
    deps.renderer.writeWarning(`Server "${name}" already in config. Updating.\n`);
  }
  // MCPServerConfig is a closed interface (no string index signature), but
  // the on-disk JSON shape stores it as a plain object — cast through unknown
  // so we can land it without widening the public type.
  mcpServers[name] = serverCfg as unknown as Record<string, unknown>;
  existing.mcpServers = mcpServers;

  await atomicWrite(deps.paths.globalConfig, JSON.stringify(existing, null, 2));
  const verb = enable ? 'Enabled' : 'Added (disabled — set enabled:true to activate)';
  deps.renderer.writeInfo(`${verb} "${name}" (${serverCfg.transport}). Config written to ${deps.paths.globalConfig}.\n`);
  return 0;
}

async function removeMcpServer(name: string, deps: SubcommandDeps): Promise<number> {
  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(deps.paths.globalConfig, 'utf8');
    existing = JSON.parse(raw);
  } catch {
    deps.renderer.writeError('No config file found.\n');
    return 1;
  }

  const mcpServers = (existing.mcpServers as Record<string, Record<string, unknown>> | undefined) ?? {};
  if (!mcpServers[name]) {
    deps.renderer.writeError(`Server "${name}" not in config.\n`);
    return 1;
  }
  delete mcpServers[name];
  existing.mcpServers = mcpServers;

  await atomicWrite(deps.paths.globalConfig, JSON.stringify(existing, null, 2));
  deps.renderer.writeInfo(`Removed "${name}" from config.\n`);
  return 0;
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
    `  apiVersion:    ${API_VERSION}`,
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

/**
 * V3-A: `wstack doctor` — runs a battery of checks and returns non-zero
 * if any are unhealthy. Unlike `diag` (which dumps facts), `doctor` makes
 * a judgement call per check so users get an actionable list of fix-ups
 * instead of having to interpret raw config.
 */
async function doctorCmd(_args: string[], deps: SubcommandDeps): Promise<number> {
  type CheckResult = { name: string; status: 'ok' | 'warn' | 'fail'; detail: string };
  const checks: CheckResult[] = [];

  // 1. Provider + model are set
  const cfg = deps.config;
  if (!cfg.provider) {
    checks.push({ name: 'provider', status: 'fail', detail: 'no provider configured — run `wstack init` or `wstack auth`' });
  } else {
    checks.push({ name: 'provider', status: 'ok', detail: cfg.provider });
  }
  if (!cfg.model) {
    checks.push({ name: 'model', status: 'fail', detail: 'no model configured — run `wstack init`' });
  } else {
    checks.push({ name: 'model', status: 'ok', detail: cfg.model });
  }

  // 2. An API key is reachable (either in vault or env)
  if (cfg.provider) {
    const providerCfg = (cfg.providers as Record<string, { apiKey?: string; envVars?: string[] }> | undefined)?.[cfg.provider];
    const hasVaultKey = typeof providerCfg?.apiKey === 'string' && providerCfg.apiKey.length > 0;
    const envHit = providerCfg?.envVars?.some((v) => process.env[v]) ?? false;
    if (hasVaultKey || envHit) {
      checks.push({
        name: 'api key',
        status: 'ok',
        detail: hasVaultKey ? 'found in vault' : 'found in env',
      });
    } else {
      checks.push({
        name: 'api key',
        status: 'fail',
        detail: `no key for "${cfg.provider}" in vault or env — run \`wstack auth ${cfg.provider}\``,
      });
    }
  }

  // 3. models.dev cache is reasonably fresh (< 7 days)
  try {
    const age = await deps.modelsRegistry.ageSeconds();
    if (!isFinite(age)) {
      checks.push({ name: 'models cache', status: 'warn', detail: 'never fetched — run `wstack models refresh`' });
    } else if (age > 7 * 24 * 3600) {
      checks.push({
        name: 'models cache',
        status: 'warn',
        detail: `${Math.round(age / 86400)} days old — run \`wstack models refresh\``,
      });
    } else {
      checks.push({ name: 'models cache', status: 'ok', detail: `${Math.round(age / 60)}m old` });
    }
  } catch (err) {
    checks.push({
      name: 'models cache',
      status: 'warn',
      detail: `read failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 4. Vault file is readable when present
  try {
    await fs.access(deps.paths.secretsKey);
    checks.push({ name: 'secret vault', status: 'ok', detail: deps.paths.secretsKey });
  } catch {
    checks.push({
      name: 'secret vault',
      status: 'warn',
      detail: 'not yet initialized (created lazily on first encrypt)',
    });
  }

  // 5. Project sessions dir is writable
  try {
    await fs.mkdir(deps.paths.projectSessions, { recursive: true });
    const probe = path.join(deps.paths.projectSessions, `.probe-${Date.now()}`);
    await fs.writeFile(probe, '');
    await fs.unlink(probe);
    checks.push({ name: 'sessions writable', status: 'ok', detail: deps.paths.projectSessions });
  } catch (err) {
    checks.push({
      name: 'sessions writable',
      status: 'fail',
      detail: `cannot write to ${deps.paths.projectSessions}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 6. Each enabled MCP server has a reachable command/url
  const mcpEntries = Object.entries(cfg.mcpServers ?? {}) as [
    string,
    { enabled?: boolean; transport?: string; command?: string; url?: string },
  ][];
  for (const [name, srv] of mcpEntries) {
    if (!srv.enabled) continue;
    if ((srv.transport === 'sse' || srv.transport === 'streamable-http') && !srv.url) {
      checks.push({ name: `mcp:${name}`, status: 'fail', detail: 'transport requires url' });
    } else if (srv.transport === 'stdio' && !srv.command) {
      checks.push({ name: `mcp:${name}`, status: 'fail', detail: 'stdio transport requires command' });
    } else {
      checks.push({ name: `mcp:${name}`, status: 'ok', detail: `${srv.transport} ${srv.command ?? srv.url ?? ''}`.trim() });
    }
  }

  // 7. Node engine
  const major = Number.parseInt(process.version.replace(/^v/, '').split('.')[0] ?? '0', 10);
  if (major < 22) {
    checks.push({ name: 'node', status: 'fail', detail: `${process.version} (need ≥22)` });
  } else {
    checks.push({ name: 'node', status: 'ok', detail: process.version });
  }

  // Render
  deps.renderer.write(color.bold('WrongStack doctor\n\n'));
  let failed = 0;
  let warned = 0;
  for (const c of checks) {
    const icon = c.status === 'ok' ? color.green('✓') : c.status === 'warn' ? color.amber('●') : color.red('✗');
    deps.renderer.write(`  ${icon} ${c.name.padEnd(20)} ${color.dim(c.detail)}\n`);
    if (c.status === 'fail') failed++;
    if (c.status === 'warn') warned++;
  }
  deps.renderer.write('\n');
  if (failed > 0) {
    deps.renderer.write(color.red(`${failed} failed, ${warned} warning${warned === 1 ? '' : 's'}\n`));
    return 1;
  }
  if (warned > 0) {
    deps.renderer.write(color.amber(`All checks passed (${warned} warning${warned === 1 ? '' : 's'})\n`));
    return 0;
  }
  deps.renderer.write(color.green('All checks passed.\n'));
  return 0;
}

async function exportCmd(args: string[], deps: SubcommandDeps): Promise<number> {
  if (!deps.sessionStore) {
    deps.renderer.writeError('No session store configured.');
    return 1;
  }

  let format: 'markdown' | 'json' | 'text' = 'markdown';
  let output: string | undefined;
  let includeTools = true;
  let includeDiagnostics = true;
  let sessionId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--format' || a === '-f') {
      const v = args[++i];
      if (v !== 'markdown' && v !== 'json' && v !== 'text') {
        deps.renderer.writeError(`Unknown --format ${v}. Use markdown, json, or text.`);
        return 1;
      }
      format = v;
    } else if (a === '--out' || a === '-o') {
      output = args[++i];
    } else if (a === '--no-tools') {
      includeTools = false;
    } else if (a === '--no-diagnostics') {
      includeDiagnostics = false;
    } else if (a.startsWith('-')) {
      deps.renderer.writeError(`Unknown flag: ${a}`);
      return 1;
    } else if (!sessionId) {
      sessionId = a;
    }
  }

  if (!sessionId) {
    deps.renderer.writeError('Usage: wstack export <sessionId> [--format markdown|json|text] [--out <file>] [--no-tools] [--no-diagnostics]');
    return 1;
  }

  const reader = new DefaultSessionReader({ store: deps.sessionStore });
  let rendered: string;
  try {
    rendered = await reader.export(sessionId, {
      format,
      includeTools,
      includeDiagnostics,
    });
  } catch (err) {
    deps.renderer.writeError(
      `Export failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  if (output) {
    await fs.mkdir(path.dirname(path.resolve(deps.cwd, output)), { recursive: true });
    await fs.writeFile(path.resolve(deps.cwd, output), rendered, 'utf8');
    deps.renderer.write(`Wrote ${rendered.length} bytes to ${output}\n`);
  } else {
    deps.renderer.write(rendered);
    if (!rendered.endsWith('\n')) deps.renderer.write('\n');
  }
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
    `WrongStack ${CLI_VERSION} (apiVersion ${API_VERSION}, node ${process.version}, ${os.platform()})\n`,
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
    '  wstack auth                  Interactive key manager (list/add/update/delete)',
    '  wstack auth <provider>       Append one key for a provider (encrypted at rest)',
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
    '  wstack doctor                Health checks (config, keys, MCP, node)',
    '  wstack export <id> [opts]    Render a session (--format markdown|json|text, --out <file>)',
    '  wstack usage                 Token + cost summary',
    '  wstack version               Print version',
    '',
    'Global flags:',
    '  --provider, --model, --cwd, --log-level, --yolo, --verbose, --trace, --config',
    '  --director                   Run with Director-backed orchestration (writes fleet manifest)',
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
