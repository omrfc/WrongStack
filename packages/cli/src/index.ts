import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  Agent,
  Container,
  EventBus,
  TOKENS,
  ToolRegistry,
  ProviderRegistry,
  SlashCommandRegistry,
  DefaultLogger,
  DefaultPathResolver,
  DefaultSecretScrubber,
  DefaultRetryPolicy,
  DefaultErrorHandler,
  DefaultTokenCounter,
  DefaultSessionStore,
  RecoveryLock,
  QueueStore,
  DefaultAttachmentStore,
  DefaultSecretVault,
  migratePlaintextSecrets,
  DefaultMemoryStore,
  DefaultPermissionPolicy,
  DefaultSkillLoader,
  DefaultConfigLoader,
  DefaultSystemPromptBuilder,
  DefaultModelsRegistry,
  HybridCompactor,
  Context,
  createContextManagerTool,
  createDefaultPipelines,
  loadPlugins,
  resolveWstackPaths,
  color,
  type Plugin,
  type Config,
  type SystemPromptBuilder,
  type WstackPaths,
} from '@wrongstack/core';
import { buildProviderFactoriesFromRegistry, makeProviderFromConfig } from '@wrongstack/providers';
import { builtinTools, rememberTool, forgetTool } from '@wrongstack/tools';
import { MCPRegistry } from '@wrongstack/mcp';
import { TerminalRenderer } from './renderer.js';
import { ReadlineInputReader } from './input-reader.js';
import { runRepl } from './repl.js';
import { buildBuiltinSlashCommands } from './slash-commands/index.js';
import { Spinner } from './spinner.js';
import { SessionStats } from './session-stats.js';
import { makePromptDelegate } from './permission-prompt.js';
import { subcommands } from './subcommands/index.js';

interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positional: string[];
}

const BOOLEAN_FLAGS = new Set([
  'yolo',
  'verbose',
  'trace',
  'help',
  'version',
  'no-banner',
  'no-features',
  'tui',
  'no-tui',
  'no-recovery',
  'recover',
]);

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const name = a.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true;
        continue;
      }
      if (i + 1 < argv.length && !(argv[i + 1] ?? '').startsWith('-')) {
        flags[name] = argv[++i] ?? '';
      } else {
        flags[name] = true;
      }
    } else if (a.startsWith('-') && a.length === 2) {
      const short = a.slice(1);
      const expand: Record<string, string> = { v: 'verbose' };
      flags[expand[short] ?? short] = true;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function flagsToConfigPatch(flags: Record<string, string | boolean>): Partial<Config> {
  const patch: Partial<Config> = {};
  if (typeof flags['provider'] === 'string') patch.provider = flags['provider'];
  if (typeof flags['model'] === 'string') patch.model = flags['model'];
  if (typeof flags['cwd'] === 'string') patch.cwd = flags['cwd'];
  if (typeof flags['log-level'] === 'string') {
    patch.log = { level: flags['log-level'] as Config['log']['level'] };
  } else if (flags['verbose']) {
    patch.log = { level: 'debug' };
  } else if (flags['trace']) {
    patch.log = { level: 'trace' };
  }
  if (flags['yolo']) patch.yolo = true;
  if (flags['no-features']) {
    patch.features = {
      mcp: false,
      plugins: false,
      memory: false,
      modelsRegistry: false,
      skills: false,
    };
  }
  return patch;
}

function resolveBundledSkillsDir(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const corePkg = req.resolve('@wrongstack/core/package.json');
    return path.join(path.dirname(corePkg), 'skills');
  } catch {
    return undefined;
  }
}

async function ensureProjectMeta(paths: WstackPaths, projectRoot: string): Promise<void> {
  try {
    await fs.mkdir(paths.projectDir, { recursive: true });
    const meta = {
      hash: paths.projectHash,
      root: projectRoot,
      lastSeen: new Date().toISOString(),
    };
    await fs.writeFile(paths.projectMeta, JSON.stringify(meta, null, 2));
  } catch {
    // best-effort
  }
}

export async function main(argv: string[]): Promise<number> {
  const { flags, positional } = parseArgs(argv);

  const cwd = typeof flags['cwd'] === 'string' ? path.resolve(flags['cwd']) : process.cwd();
  const pathResolver = new DefaultPathResolver(cwd);
  const projectRoot = pathResolver.projectRoot;
  const userHome = os.homedir();
  const wpaths = resolveWstackPaths({ projectRoot, userHome });
  await ensureProjectMeta(wpaths, projectRoot);

  // `wstack resume <id>` is sugar for `wstack --resume <id>`. Lift it
  // before subcommand dispatch so resume falls through to the normal
  // REPL flow with the session pre-loaded.
  if (positional[0] === 'resume' && positional[1] && !subcommands['__noop_resume_marker']) {
    flags['resume'] = positional[1];
    positional.splice(0, 2);
  }

  // Vault must come first so the config loader can decrypt apiKey-like
  // fields. It lazily creates ~/.wrongstack/.key on first encrypt/decrypt.
  const vault = new DefaultSecretVault({ keyFile: wpaths.secretsKey });

  // Auto-encrypt any plaintext secrets users still have in their config
  // files (left over from before the vault existed, or hand-written).
  // Silent no-op for already-encrypted configs.
  for (const file of [wpaths.globalConfig, wpaths.projectLocalConfig]) {
    try {
      const { migrated } = await migratePlaintextSecrets(file, vault);
      if (migrated > 0) {
        process.stderr.write(
          `[wstack] Encrypted ${migrated} plaintext secret(s) in ${file}\n`,
        );
      }
    } catch {
      // best-effort — never block boot on migration issues
    }
  }

  const configLoader = new DefaultConfigLoader({ paths: wpaths, vault });
  let config: Config;
  try {
    config = await configLoader.load({ cliFlags: flagsToConfigPatch(flags) });
  } catch (err) {
    process.stderr.write(`Config error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  // Logger — operational log lives in user home
  const logger = new DefaultLogger({
    level: config.log.level,
    file: wpaths.logFile,
  });
  const renderer = new TerminalRenderer();
  const reader = new ReadlineInputReader({ historyFile: wpaths.historyFile });

  // ModelsRegistry — source of truth for providers, models, pricing.
  const modelsRegistry = new DefaultModelsRegistry({
    cacheFile: wpaths.modelsCache,
    ttlSeconds: 24 * 3600,
  });

  // Quick path: subcommand dispatch (no provider required for most)
  const first = positional[0];
  if (first && subcommands[first]) {
    const sessionStore = new DefaultSessionStore({ dir: wpaths.projectSessions });
    const skillLoader = new DefaultSkillLoader({
      paths: wpaths,
      bundledDir: resolveBundledSkillsDir(),
    });
    const toolRegistryForSubcmd = new ToolRegistry();
    for (const t of builtinTools) toolRegistryForSubcmd.register(t);
    const code = await subcommands[first]!(positional.slice(1), {
      config,
      renderer,
      reader,
      sessionStore,
      skillLoader,
      toolRegistry: toolRegistryForSubcmd,
      modelsRegistry,
      paths: wpaths,
      vault,
      cwd,
      projectRoot,
      userHome,
    });
    await reader.close();
    return code;
  }

  // Identity required from this point
  if (!config.provider || !config.model) {
    process.stderr.write(
      'No provider or model configured. Run `wstack init` first, or set ' +
        'WRONGSTACK_PROVIDER + WRONGSTACK_MODEL.\n',
    );
    await reader.close();
    return 2;
  }

  // Resolve provider details from models.dev
  const resolvedProvider = await modelsRegistry.getProvider(config.provider).catch(() => undefined);
  if (!resolvedProvider) {
    logger.warn(
      `Provider "${config.provider}" not found in models.dev. Continuing with raw config.`,
    );
  } else if (resolvedProvider.family === 'unsupported') {
    process.stderr.write(
      `Provider "${config.provider}" uses an unsupported wire family (${resolvedProvider.npm}). ` +
        `Install a plugin to enable it, or pick a different provider.\n`,
    );
    await reader.close();
    return 2;
  }

  // Build container + services
  const container = new Container();
  container.bind(TOKENS.Logger, () => logger);
  container.bind(TOKENS.PathResolver, () => pathResolver);
  container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
  container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
  container.bind(TOKENS.ModelsRegistry, () => modelsRegistry);
  container.bind(
    TOKENS.TokenCounter,
    () => new DefaultTokenCounter({ registry: modelsRegistry, providerId: config.provider }),
  );
  container.bind(TOKENS.SessionStore, () => new DefaultSessionStore({ dir: wpaths.projectSessions }));
  const memoryStore = new DefaultMemoryStore({ paths: wpaths });
  container.bind(TOKENS.MemoryStore, () => memoryStore);
  // Skills are an opt-in feature pack — when disabled we still bind a
  // loader that returns an empty list so the prompt builder doesn't
  // need a special path. This way `--no-features` doesn't drift behaviour.
  const skillLoader = new DefaultSkillLoader({
    paths: wpaths,
    bundledDir: config.features.skills ? resolveBundledSkillsDir() : undefined,
  });
  container.bind(TOKENS.SkillLoader, () => skillLoader);
  container.bind(
    TOKENS.SystemPromptBuilder,
    () =>
      new DefaultSystemPromptBuilder({
        memoryStore,
        skillLoader: config.features.skills ? skillLoader : undefined,
      }),
  );
  container.bind(TOKENS.Renderer, () => renderer);
  container.bind(TOKENS.InputReader, () => reader);
  container.bind(
    TOKENS.PermissionPolicy,
    () =>
      new DefaultPermissionPolicy({
        trustFile: wpaths.projectTrust,
        yolo: config.yolo,
        promptDelegate: makePromptDelegate(reader),
      }),
  );
  container.bind(
    TOKENS.Compactor,
    () =>
      new HybridCompactor({
        preserveK: config.context.preserveK,
        eliseThreshold: config.context.eliseThreshold,
      }),
  );

  // Provider registry — populated dynamically from models.dev catalog
  // when enabled. With features.modelsRegistry=false we don't touch the
  // network at boot and rely on the user's config to declare the wire
  // family explicitly (see makeProviderFromConfig path below).
  const providerRegistry = new ProviderRegistry();
  if (config.features.modelsRegistry) {
    try {
      const factories = await buildProviderFactoriesFromRegistry({
        registry: modelsRegistry,
        log: logger,
      });
      for (const f of factories) providerRegistry.register(f);
    } catch (err) {
      process.stderr.write(
        `Failed to load models.dev registry: ${err instanceof Error ? err.message : err}\n` +
          `Try \`wstack models refresh\` once you have network access, or run with --no-features.\n`,
      );
      await reader.close();
      return 2;
    }
  }

  // Compactor — also wired into createContextManagerTool below
  const compactor = container.resolve(TOKENS.Compactor);

  // Tool registry
  const toolRegistry = new ToolRegistry();
  for (const t of builtinTools) toolRegistry.register(t);
  toolRegistry.registerDefault(
    createContextManagerTool({ compactor }),
  );
  if (config.features.memory) {
    toolRegistry.register(rememberTool(memoryStore));
    toolRegistry.register(forgetTool(memoryStore));
  }

  const events = new EventBus();
  events.setLogger(logger);

  // Spinner: visible "thinking…" line during each model request.
  const spinner = new Spinner();
  events.on('iteration.started', () => {
    spinner.start(color.dim(`${config.provider}/${config.model} thinking…`));
  });
  events.on('provider.response', () => {
    spinner.stop();
  });
  events.on('error', () => {
    spinner.stop();
  });

  // Live streaming output: first text_delta stops the spinner and starts
  // writing tokens directly so the user sees the model "type".
  let streamingActive = false;
  events.on('provider.text_delta', (p) => {
    if (!streamingActive) {
      spinner.stop();
      streamingActive = true;
    }
    renderer.write(p.text);
  });
  events.on('iteration.completed', () => {
    if (streamingActive) {
      renderer.write('\n');
      streamingActive = false;
    }
  });

  // Provider hiccups — render a single friendly line instead of leaving the
  // raw JSON body in logger output. retry events show a countdown; error
  // events surface a final failure that won't be retried.
  events.on('provider.retry', (p) => {
    spinner.stop();
    if (streamingActive) {
      renderer.write('\n');
      streamingActive = false;
    }
    const secs = (p.delayMs / 1000).toFixed(p.delayMs >= 1000 ? 1 : 2);
    process.stderr.write(
      color.yellow(`  ⟳ retry ${p.attempt} in ${secs}s — ${p.description}\n`),
    );
    spinner.start(color.dim(`${config.provider}/${config.model} thinking…`));
  });
  events.on('provider.error', (p) => {
    spinner.stop();
    if (streamingActive) {
      renderer.write('\n');
      streamingActive = false;
    }
    process.stderr.write(color.red(`  ✗ ${p.description}\n`));
  });

  // Provider instance — registry-driven by default, but falls through to
  // config-only construction when the catalog is unavailable (or the
  // user explicitly disabled it).
  const providerConfig = config.providers?.[config.provider] ?? {
    type: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  };
  let provider: ReturnType<ProviderRegistry['create']>;
  try {
    if (config.features.modelsRegistry) {
      provider = providerRegistry.create({ ...providerConfig, type: config.provider });
    } else {
      provider = makeProviderFromConfig(config.provider, {
        ...providerConfig,
        type: config.provider,
      });
    }
  } catch (err) {
    process.stderr.write(
      `Failed to create provider: ${err instanceof Error ? err.message : err}\n`,
    );
    await reader.close();
    return 2;
  }

  // Build system prompt
  const promptBuilder = container.resolve(TOKENS.SystemPromptBuilder) as SystemPromptBuilder;
  const systemPrompt = await promptBuilder.build({
    cwd,
    projectRoot,
    tools: toolRegistry.list(),
    provider: config.provider,
    model: config.model,
  });

  // Session — fresh by default, or resumed from disk if --resume <id> was passed.
  const sessionStore = container.resolve(TOKENS.SessionStore);
  let resumeId = typeof flags['resume'] === 'string' ? flags['resume'] : undefined;

  // Crash recovery: if the last interactive run was killed mid-flight,
  // its `active.json` lockfile is still on disk and the session has no
  // `session_end` event. Offer to resume it before opening a fresh one.
  // Skipped when the user explicitly chose `--resume <id>` or asked to
  // bypass with `--no-recovery`.
  const recoveryLock = new RecoveryLock({
    dir: wpaths.projectSessions,
    sessionStore,
  });
  if (!resumeId && !flags['no-recovery']) {
    const abandoned = await recoveryLock.checkAbandoned();
    if (abandoned && abandoned.messageCount > 0) {
      const choice = await promptRecovery(reader, renderer, abandoned, !!flags['recover']);
      if (choice === 'resume') {
        resumeId = abandoned.sessionId;
      } else if (choice === 'delete') {
        await sessionStore.delete(abandoned.sessionId).catch(() => undefined);
        await recoveryLock.clear();
      } else {
        // 'skip' — leave the file on disk, just clear the lock so we
        // don't ask again every launch.
        await recoveryLock.clear();
      }
    } else if (abandoned) {
      // Empty session (no real work done) — silently discard.
      await sessionStore.delete(abandoned.sessionId).catch(() => undefined);
      await recoveryLock.clear();
    }
  }

  let session;
  let restoredMessages: import('@wrongstack/core').Message[] = [];
  if (resumeId) {
    try {
      const resumed = await sessionStore.resume(resumeId);
      session = resumed.writer;
      restoredMessages = resumed.data.messages;
      renderer.writeInfo(
        `Resumed session ${resumed.data.metadata.id} — ${restoredMessages.length} messages, ${resumed.data.usage.input + resumed.data.usage.output} tokens used previously.`,
      );
    } catch (err) {
      renderer.writeError(
        `Resume failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 2;
    }
  } else {
    session = await sessionStore.create({
      id: '',
      title: '',
      model: config.model,
      provider: config.provider,
    });
  }

  // Claim the lock for this session. Released in the finally block below.
  await recoveryLock.write(session.id).catch(() => undefined);

  // Attachment store: per-session, spooled under sessions/<id>/attachments/.
  const attachments = new DefaultAttachmentStore({
    spoolDir: path.join(wpaths.projectSessions, session.id, 'attachments'),
  });

  // Queue persistence (TUI only — the REPL has no concurrent input).
  // Lives next to attachments so deleting the session dir cleans both.
  const queueStore = new QueueStore({
    dir: path.join(wpaths.projectSessions, session.id),
  });

  const tokenCounter = container.resolve(TOKENS.TokenCounter);

  // Session stats tracker — subscribes to events; rendered at the end.
  const stats = new SessionStats(events, tokenCounter);

  const ctxSignal = new AbortController().signal;
  const context = new Context({
    systemPrompt,
    provider,
    session,
    signal: ctxSignal,
    tokenCounter,
    cwd,
    projectRoot,
    model: config.model,
  });
  // Hydrate the transcript when resuming so the model sees the prior
  // conversation. Order is preserved from the JSONL log.
  if (restoredMessages.length > 0) {
    context.messages.push(...restoredMessages);
  }

  const pipelines = createDefaultPipelines();
  const agent = new Agent({
    container,
    tools: toolRegistry,
    providers: providerRegistry,
    events,
    pipelines,
    context,
    maxIterations: config.tools.maxIterations,
    iterationTimeoutMs: config.tools.iterationTimeoutMs,
    executionStrategy: config.tools.defaultExecutionStrategy,
    perIterationOutputCapBytes: config.tools.perIterationOutputCapBytes,
  });

  // MCP servers
  const mcpRegistry = new MCPRegistry({ toolRegistry, events, log: logger });
  if (config.features.mcp) {
    for (const cfg of Object.values(config.mcpServers ?? {})) {
      try {
        await mcpRegistry.start(cfg);
      } catch (err) {
        logger.warn(`MCP server "${cfg.name}" failed to start`, err);
      }
    }
  }

  // Slash registry — created before plugins so plugins can register commands.
  const slashRegistry = new SlashCommandRegistry();

  // Plugins
  if (config.features.plugins && config.plugins && config.plugins.length > 0) {
    const resolvedPlugins: Plugin[] = [];
    for (const p of config.plugins) {
      const spec = typeof p === 'string' ? p : p.name;
      try {
        const mod = (await import(spec)) as { default?: Plugin };
        if (mod.default) resolvedPlugins.push(mod.default);
      } catch (err) {
        logger.warn(`Plugin "${spec}" failed to load`, err);
      }
    }
    if (resolvedPlugins.length > 0) {
      const { default: createApi } = await import('./plugin-api-factory.js');
      await loadPlugins(resolvedPlugins, {
        log: logger,
        apiFactory: (plugin) =>
          createApi(plugin.name, {
            container,
            events,
            pipelines: pipelines as unknown as Parameters<typeof createApi>[1]['pipelines'],
            toolRegistry,
            providerRegistry,
            slashCommandRegistry: slashRegistry,
            mcpRegistry,
            config,
            log: logger,
          }),
      });
    }
  }

  const slashCmds = buildBuiltinSlashCommands({
    registry: slashRegistry,
    toolRegistry,
    compactor: container.resolve(TOKENS.Compactor),
    sessionStore,
    skillLoader,
    tokenCounter,
    renderer,
    onExit: () => {
      void mcpRegistry.stopAll();
    },
    onSwitchModel: (name) => {
      context.model = name;
    },
    onSwitchProvider: (name) => {
      try {
        const newCfg = config.providers?.[name] ?? {
          type: name,
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
        };
        const newProvider = providerRegistry.create({ ...newCfg, type: name });
        context.provider = newProvider;
        (config as { provider?: string }).provider = name;
      } catch (err) {
        renderer.writeError(
          `Cannot switch to "${name}": ${err instanceof Error ? err.message : err}`,
        );
      }
    },
    onDiag: () => {
      const u = tokenCounter.total();
      const cost = tokenCounter.estimateCost();
      renderer.write(
        [
          `${color.bold('WrongStack diag')}`,
          `  provider:     ${config.provider} / ${context.model}`,
          `  projectRoot:  ${projectRoot}`,
          `  tokens:       in ${u.input}  out ${u.output}  cacheR ${u.cacheRead ?? 0}`,
          `  cost:         $${cost.total.toFixed(4)}`,
          `  tools:        ${toolRegistry.list().length}`,
          `  mcpServers:   ${mcpRegistry.list().length}`,
          '',
        ].join('\n'),
      );
    },
    onStats: () => {
      stats.render(renderer);
    },
  });
  for (const cmd of slashCmds) slashRegistry.register(cmd);

  // Single-shot vs REPL
  let code = 0;
  try {
    if (positional.length > 0) {
      const query = positional.join(' ');
      const ctrl = new AbortController();
      const onSigint = () => ctrl.abort();
      process.on('SIGINT', onSigint);
      const startedAt = Date.now();
      const before = tokenCounter.total();
      const costBefore = tokenCounter.estimateCost().total;
      try {
        const result = await agent.run(query, { signal: ctrl.signal });
        if (result.status === 'failed') {
          code = 1;
          renderer.writeError(
            'Failed: ' +
              (result.error instanceof Error ? result.error.message : String(result.error)),
          );
        } else if (result.status === 'aborted') {
          code = 130;
          renderer.writeWarning('Aborted.');
        } else if (result.status === 'max_iterations') {
          code = 1;
          renderer.writeWarning(`Hit max iterations (${result.iterations}).`);
        }
        const after = tokenCounter.total();
        const costAfter = tokenCounter.estimateCost().total;
        renderer.write(
          '\n' +
            color.dim(
              `[in: ${fmtTok(after.input - before.input)}  out: ${fmtTok(after.output - before.output)}  iters: ${result.iterations}  cost: $${(costAfter - costBefore).toFixed(4)}  ${((Date.now() - startedAt) / 1000).toFixed(1)}s]`,
            ) +
            '\n',
        );
      } finally {
        process.off('SIGINT', onSigint);
      }
    } else if (flags.tui && !flags['no-tui']) {
      // Lazy-load to avoid pulling React/Ink into the cold path for non-TUI usage.
      const { runTui } = await import('@wrongstack/tui');
      code = await runTui({
        agent,
        events,
        slashRegistry,
        attachments,
        tokenCounter,
        model: context.model,
        banner: !flags['no-banner'],
        queueStore,
      });
    } else {
      code = await runRepl({
        agent,
        renderer,
        reader,
        slashRegistry,
        tokenCounter,
        attachments,
      });
    }
  } finally {
    stats.render(renderer);
    await mcpRegistry.stopAll();
    await session.append({
      type: 'session_end',
      ts: new Date().toISOString(),
      usage: tokenCounter.total(),
    });
    await session.close();
    await recoveryLock.clear().catch(() => undefined);
    await reader.close();
  }
  return code;
}

/**
 * Prompt the user about an abandoned session. The lockfile lifecycle
 * guarantees we only get here when the previous instance died without
 * writing `session_end` AND there's real work on disk (≥1 message).
 *
 * `--recover` short-circuits to "resume" without asking; piped/non-TTY
 * input degrades to the same — the alternative is hanging on stdin or
 * forcing the user to remember a flag they never typed.
 */
async function promptRecovery(
  reader: ReadlineInputReader,
  renderer: TerminalRenderer,
  abandoned: import('@wrongstack/core').AbandonedSession,
  autoRecover: boolean,
): Promise<'resume' | 'delete' | 'skip'> {
  const minutes = Math.round(abandoned.ageMs / 60_000);
  const ageLabel =
    minutes < 1 ? `${Math.round(abandoned.ageMs / 1000)}s ago` :
    minutes < 60 ? `${minutes} min ago` :
    `${Math.round(minutes / 60)}h ago`;
  const summary = `Previous session was killed mid-run: ${abandoned.sessionId} (${abandoned.messageCount} messages, ${ageLabel}).`;
  if (autoRecover) {
    renderer.writeInfo(`${summary} Auto-resuming (--recover).`);
    return 'resume';
  }
  if (!process.stdin.isTTY) {
    renderer.writeInfo(`${summary} Non-interactive — leaving as-is. Use \`wstack resume ${abandoned.sessionId}\` or pass \`--recover\` to auto-resume.`);
    return 'skip';
  }
  renderer.writeInfo(summary);
  const answer = await reader.readKey(
    `${color.amber('?')} Recover it? ${color.dim('[')}${color.bold('Y')}es / ${color.bold('n')}o / ${color.bold('d')}elete${color.dim(']')} `,
    [
      { key: 'y', label: 'yes', value: 'resume' },
      { key: 'Y', label: 'yes', value: 'resume' },
      { key: '\r', label: 'yes', value: 'resume' },
      { key: '\n', label: 'yes', value: 'resume' },
      { key: 'n', label: 'no', value: 'skip' },
      { key: 'N', label: 'no', value: 'skip' },
      { key: 'd', label: 'delete', value: 'delete' },
      { key: 'D', label: 'delete', value: 'delete' },
    ],
  );
  return answer as 'resume' | 'delete' | 'skip';
}

function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

const isMain =
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` ||
  process.argv[1]?.endsWith('/cli/dist/index.js') ||
  process.argv[1]?.endsWith('\\cli\\dist\\index.js');
if (isMain) {
  main(process.argv.slice(2)).then(
    (c) => {
      // Set exitCode and let Node drain async handles (undici TLS, log file
      // flushes) naturally. Force-exit after a brief grace period so we don't
      // hang if a plugin or MCP server leaks. Avoids libuv UV_HANDLE_CLOSING
      // assertions seen on Windows when process.exit() races with handle teardown.
      process.exitCode = c;
      setTimeout(() => process.exit(c), 200).unref();
    },
    (err) => {
      process.stderr.write((err instanceof Error ? err.stack : String(err)) + '\n');
      process.exitCode = 1;
      setTimeout(() => process.exit(1), 200).unref();
    },
  );
}
