/**
 * Execution phase — single-shot, TUI, REPL, and WebUI dispatch.
 * Extracted from index.ts so the main() function focuses on
 * boot + wiring; this file owns the three run modes and cleanup.
 */
import * as path from 'node:path';
import type {
  Agent,
  AttachmentStore,
  Config,
  Director,
  EventBus,
  ModelsRegistry,
  RecoveryLock,
  SessionWriter,
  SlashCommandRegistry,
  TokenCounter,
} from '@wrongstack/core';
import { color } from '@wrongstack/core';
import type { ProviderConfig, ResolvedProvider, WstackPaths } from '@wrongstack/core';
import type { MCPRegistry } from '@wrongstack/mcp';
import { createToolVisionAdapters } from '@wrongstack/runtime/vision';
import { capabilitiesFor } from '@wrongstack/providers';
import type { ReadlineInputReader } from './input-reader.js';
import type { TerminalRenderer } from './renderer.js';
import { runRepl } from './repl.js';
import type { SessionStats } from './session-stats.js';
import { fmtTok } from './utils.js';
import { CLI_VERSION } from './version.js';

export interface ExecutionDeps {
  agent: Agent;
  events: EventBus;
  slashRegistry: SlashCommandRegistry;
  attachments: AttachmentStore;
  tokenCounter: TokenCounter;
  config: Config;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  session: SessionWriter;
  mcpRegistry: MCPRegistry;
  recoveryLock: RecoveryLock;
  wpaths: WstackPaths;
  modelsRegistry: ModelsRegistry;
  projectRoot: string;
  flags: Record<string, string | boolean>;
  positional: string[];
  effectiveMaxContext: number;
  queueStore: import('@wrongstack/core').QueueStore;
  context: import('@wrongstack/core').Context;
  stats: SessionStats;
  detachTodosCheckpoint?: () => void | Promise<void>;
  savedProviderCfg: ProviderConfig | undefined;
  resolvedProvider: ResolvedProvider | undefined;
  getPickableProviders: () => Promise<Array<{ id: string; family: string; models: string[] }>>;
  switchProviderAndModel: (providerId: string, modelId: string) => string | null;
  /** Live director instance for the TUI fleet panel. Null when director mode is off. */
  director: Director | null;
  /** Fleet roster for human-readable subagent names. */
  fleetRoster?: Record<string, { name: string }>;
  /**
   * Shared controller object for the `/fleet stream on|off` toggle. The
   * TUI installs a dispatch-backed setter on mount; the slash command
   * reads/writes via this object so both surfaces stay synchronized.
   */
  fleetStreamController?: {
    enabled: boolean;
    setEnabled: (enabled: boolean) => void;
  };
}

export async function execute(deps: ExecutionDeps): Promise<number> {
  const {
    agent,
    events,
    slashRegistry,
    attachments,
    tokenCounter,
    config,
    renderer,
    reader,
    session,
    mcpRegistry,
    recoveryLock,
    wpaths,
    modelsRegistry,
    projectRoot,
    flags,
    positional,
    effectiveMaxContext,
    queueStore,
    context,
    stats,
    detachTodosCheckpoint,
    savedProviderCfg,
    resolvedProvider,
    getPickableProviders,
    switchProviderAndModel,
    director,
    fleetRoster,
    fleetStreamController,
  } = deps;

  let code = 0;
  try {
    const visionAdapters = () => createToolVisionAdapters(agent.tools);
    const supportsVision = async (): Promise<boolean> => {
      try {
        const caps = await capabilitiesFor(modelsRegistry, context.provider.id, context.model);
        return caps.vision;
      } catch {
        return context.provider.capabilities.vision;
      }
    };
    // --prompt flag takes precedence: treat it like a positional query
    const promptFlag = typeof flags['prompt'] === 'string' ? flags['prompt'] : undefined;
    if (promptFlag) {
      positional.unshift(promptFlag);
    }
    // --goal / --ask boot directly into the TUI in goal/ask mode. The TUI is
    // the only surface with the steering + fleet panel + Esc-redirect wiring
    // that goal mode depends on, so if the user passed a goal but forgot
    // --tui, we flip --tui on for them. Single-shot positional invocation
    // still wins: `wstack --goal X "literal prompt"` runs the positional as
    // a normal single-shot (positional is non-empty), which is consistent
    // with --prompt's existing semantics.
    const goalFlag = typeof flags['goal'] === 'string' ? flags['goal'] : undefined;
    const askFlag = typeof flags['ask'] === 'string' ? flags['ask'] : undefined;
    if ((goalFlag || askFlag) && positional.length === 0 && !promptFlag) {
      flags.tui = true;
    }
    if (positional.length > 0 || promptFlag) {
      const query = positional.join(' ');
      const ctrl = new AbortController();
      const onSigint = () => ctrl.abort();
      process.on('SIGINT', onSigint);
      const startedAt = Date.now();
      const before = tokenCounter.total();
      const costBefore = tokenCounter.estimateCost().total;
      let result: import('@wrongstack/core').RunResult;
      try {
        result = await agent.run(query, { signal: ctrl.signal });
      } finally {
        process.off('SIGINT', onSigint);
      }
      const after = tokenCounter.total();
      const costAfter = tokenCounter.estimateCost().total;
      const usage = {
        input: after.input - before.input,
        output: after.output - before.output,
        iterations: result.iterations,
        cost: costAfter - costBefore,
        elapsedMs: Date.now() - startedAt,
      };
      if (flags['output-json']) {
        const json = JSON.stringify({
          status: result.status,
          finalText: result.finalText ?? null,
          error: result.error
            ? {
                code: result.error.code,
                subsystem: result.error.subsystem,
                severity: result.error.severity,
                recoverable: result.error.recoverable,
                message: result.error.message,
                context: result.error.context ?? null,
              }
            : null,
          usage,
        });
        process.stdout.write(json + '\n');
      } else {
        if (result.status === 'failed') {
          code = 1;
          const err = result.error;
          if (err) {
            const tag = err.recoverable ? ' (recoverable)' : '';
            renderer.writeError(`Failed [${err.severity}]${tag}: ${err.describe()}`);
          } else {
            renderer.writeError('Failed.');
          }
        } else if (result.status === 'aborted') {
          code = 130;
          renderer.writeWarning('Aborted.');
        } else if (result.status === 'max_iterations') {
          code = 1;
          renderer.writeWarning(`Hit max iterations (${result.iterations}).`);
        }
        if (result.finalText) renderer.write('\n' + result.finalText + '\n');
        renderer.write(
          '\n' +
            color.dim(
              `[in: ${fmtTok(usage.input)}  out: ${fmtTok(usage.output)}  iters: ${usage.iterations}  cost: ${usage.cost.toFixed(4)}  ${(usage.elapsedMs / 1000).toFixed(1)}s]`,
            ) +
            '\n',
        );
      }
    } else if (flags.tui && !flags['no-tui']) {
      // Switch from inline CLI prompts to event-driven confirmation.
      // Without this, the permission prompt writes to stdout and blocks
      // on stdin — both owned by Ink — making the prompt invisible and
      // the input deadlocked. After this call, tool.confirm_needed events
      // fire instead, which the TUI's ConfirmPrompt component handles.
      agent.disableInteractiveConfirmation();
      const { runTui } = await import('@wrongstack/tui');
      renderer.setSilent(true);
      const banneredFamily = savedProviderCfg?.family ?? resolvedProvider?.family;
      const banneredKey =
        savedProviderCfg?.apiKey ??
        config.apiKey ??
        (resolvedProvider?.envVars ?? savedProviderCfg?.envVars ?? [])
          .map((v) => process.env[v])
          .find((v): v is string => !!v);
      const banneredKeyTail =
        banneredKey && banneredKey.length >= 3 ? banneredKey.slice(-3) : undefined;
      try {
        code = await runTui({
          agent,
          events,
          slashRegistry,
          attachments,
          tokenCounter,
          visionAdapters,
          supportsVision,
          model: context.model,
          banner: !flags['no-banner'],
          queueStore,
          yolo: !!config.yolo,
          appVersion: CLI_VERSION,
          provider: config.provider,
          family: banneredFamily,
          keyTail: banneredKeyTail,
          getPickableProviders,
          switchProviderAndModel,
          effectiveMaxContext,
          // Default OFF so the terminal's native scrollback works for chat
          // history out of the box (mouse wheel / Shift+PgUp). Users who hit
          // resize/overlay-leak artifacts can opt back into alt-screen with
          // `--alt-screen` or `/altscreen on`. `--no-alt-screen` still wins
          // when both are passed.
          altScreen: flags['alt-screen'] === true && flags['no-alt-screen'] !== true,
          director,
          fleetRoster,
          onAfterExit: () => {
            process.stdout.write(
              color.dim(`Session saved: ${session.id} — resume with `) +
                color.cyan(`wstack resume ${session.id}`) +
                '\n',
            );
          },
          onClearHistory: (dispatch) => {
            dispatch({ type: 'clearHistory' });
            dispatch({ type: 'resetContextChip' });
          },
          fleetStreamController,
          initialGoal: goalFlag,
          initialAsk: askFlag,
        });
      } finally {
        renderer.setSilent(false);
      }
    } else if (flags.webui) {
      const { runWebUI } = await import('./webui-server.js');
      const webuiPromise = runWebUI({
        agent,
        events,
        session,
        port: Number.parseInt(String(flags.port ?? '3457'), 10),
        modelsRegistry,
        globalConfigPath: wpaths.globalConfig,
      });
      try {
        code = await runRepl({
          agent,
          renderer,
          reader,
          slashRegistry,
          tokenCounter,
          visionAdapters,
          supportsVision,
          attachments,
          effectiveMaxContext,
          projectName: path.basename(projectRoot) || undefined,
        });
      } finally {
        // webuiPromise must be awaited regardless of whether runRepl threw,
        // so the HTTP/WS server can shut down cleanly.
        await webuiPromise.catch(() => undefined);
      }
    } else {
      code = await runRepl({
        agent,
        renderer,
        reader,
        slashRegistry,
        tokenCounter,
        visionAdapters,
        supportsVision,
        attachments,
        effectiveMaxContext,
        projectName: path.basename(projectRoot) || undefined,
      });
    }
  } finally {
    // stats.render is synchronous but can throw — isolate it so cleanup
    // always runs regardless.
    try { stats.render(renderer); } catch (err) { /* best-effort */ }
    await Promise.resolve(detachTodosCheckpoint?.()).catch(() => undefined);
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
