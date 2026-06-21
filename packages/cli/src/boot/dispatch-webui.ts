/**
 * WebUI dispatch — extracted from the tail of `execute()`.
 *
 * PR 6 of Issue #29 (partial). The TUI-vs-REPL-vs-WebUI fork at the
 * end of `execute()` is a ~1,600-line `if/else if/else if/else`
 * chain. The WebUI branch is the most self-contained of the four: it
 * constructs a `runWebUI` options object from already-available deps,
 * wires SIGINT handling, and returns an exit code. Extracting it
 * first lets `execute()` shrink by ~100 lines and isolates the
 * WebUI-specific wiring (port resolution, browser banner, recovery
 * lock re-pointing, autonomy forwarding) in a single named module.
 *
 * The TUI branch (~1,388 lines) and the single-shot branch are left
 * inline — they are too deeply coupled to local mutable state for a
 * single-PR extraction.
 */
import type { Agent, BrainArbiter, Config, EventBus, JournalEntry, MemoryStore, ModeStore, ModelsRegistry, SessionStore, SessionWriter, SkillLoader } from '@wrongstack/core';
import { color } from '@wrongstack/core';
import type { MCPRegistry } from '@wrongstack/mcp';
import type { TerminalRenderer } from '../renderer.js';
import type { AutonomyMode } from '../slash-commands/autonomy.js';

export interface WebUIDispatchContext {
  agent: Agent;
  events: EventBus;
  session: SessionWriter;
  config: Config;
  flags: Record<string, string | boolean>;
  projectRoot: string;
  globalConfigPath: string;
  projectSessionsDir: string;
  modelsRegistry: ModelsRegistry;
  mcpRegistry: MCPRegistry;
  brain: BrainArbiter | undefined;
  brainSettings: { maxAutoRisk: import('@wrongstack/core').BrainAutoRisk } | undefined;
  getBrainLog: (() => Array<{ at: number; kind: string; question: string; outcome: string }>) | undefined;
  subscribeEternalIteration: (((fn: (entry: JournalEntry) => void) => () => void) | undefined);
  sessionStore: SessionStore | undefined;
  memoryStore: MemoryStore | undefined;
  skillLoader: SkillLoader | undefined;
  modeStore: ModeStore | undefined;
  modeId: string | undefined;
  needsSetup: boolean | undefined;
  renderer: TerminalRenderer;
  onAutonomy: ((mode: AutonomyMode) => void) | undefined;
  activeRecoveryLock: {
    clear: () => Promise<void>;
    write: (sessionId: string) => Promise<void>;
  };
}

/**
 * Run the WebUI server and block until it shuts down.
 *
 * Returns the exit code: 0 on clean shutdown, 1 on server error.
 */
export async function runWebUIDispatch(ctx: WebUIDispatchContext): Promise<number> {
  const {
    agent,
    events,
    session,
    config,
    flags,
    projectRoot,
    globalConfigPath,
    projectSessionsDir,
    modelsRegistry,
    mcpRegistry,
    brain,
    brainSettings,
    getBrainLog,
    subscribeEternalIteration,
    sessionStore,
    memoryStore,
    skillLoader,
    modeStore,
    modeId,
    needsSetup,
    renderer,
    onAutonomy,
    activeRecoveryLock,
  } = ctx;

  // Route permission confirmations to the browser (tool.confirm_needed
  // events) instead of inline terminal prompts — runWebUI forwards them to
  // the WebUI and resolves on the client's tool.confirm_result. Without
  // this, approvals appear in the terminal even when you're driving the
  // agent from the browser.
  agent.disableInteractiveConfirmation();
  // Silence CLI rendering — WebUI owns the output surface. The writeInfo
  // calls below still flow (stderr), but streaming text/tool events are
  // suppressed so they don't appear in both the terminal and the browser.
  renderer.setSilent(true);
  const { runWebUI } = await import('../webui-server.js');
  const webuiPromise = runWebUI({
    agent,
    events,
    session,
    port: Number.parseInt(String(flags.port ?? '3457'), 10),
    projectRoot,
    appConfig: config,
    open: !!flags.open,
    modelsRegistry,
    globalConfigPath,
    mcpRegistry,
    subscribeEternalIteration,
    sessionStore,
    sessionsDir: projectSessionsDir,
    brain,
    brainSettings,
    getBrainLog,
    onSessionSwapped: (newSessionId: string) => {
      // Re-point crash recovery (active.json) at the resumed session —
      // otherwise a crash after an in-app resume would offer recovery
      // for the OLD (cleanly finalized) session and miss the live one.
      void activeRecoveryLock
        .clear()
        .then(() => activeRecoveryLock.write(newSessionId))
        .catch(() => undefined);
    },
    memoryStore,
    skillLoader,
    modeStore,
    modeId,
    needsSetup,
    // Print the "open this" banner only once the server is actually
    // listening, using the RESOLVED ports. The requested port
    // (flags.port) auto-advances past busy ports inside runWebUI, so a
    // banner printed up-front with flags.port lies whenever 3456/3457 are
    // taken (a second instance, leftover sockets). Bind is 127.0.0.1-only,
    // so the host must be the literal IPv4 loopback — `localhost` resolves
    // to `::1` first on Windows and never reaches the server.
    onListening: ({ httpPort: boundHttpPort }) => {
      renderer.writeInfo(
        color.green(
          `  ✦ WebUI running → ${color.bold(`http://127.0.0.1:${boundHttpPort}`)}`,
        ),
      );
      renderer.writeInfo(
        color.dim('  Press Ctrl+C in this terminal to stop the WebUI server.\n'),
      );
    },
    // Make autonomy.switch from the browser flip the CLI's real
    // autonomy mode — context.meta alone never reaches the run loop.
    onAutonomySwitch: (mode: string) => {
      if (
        mode === 'off' ||
        mode === 'suggest' ||
        mode === 'auto' ||
        mode === 'eternal' ||
        mode === 'eternal-parallel'
      ) {
        onAutonomy?.(mode as AutonomyMode);
      }
    },
  });
  // In --webui mode, skip the full REPL — just keep the process alive
  // until the WebUI server shuts down. The WebUI WS handler listens for
  // /exit or abort signals and resolves webuiPromise when the server stops.
  // The ready banner is printed from `onListening` above (with the resolved
  // ports), not here — printing it up-front with the requested port lied
  // whenever the port auto-advanced.
  const webuiExit = new Promise<number>((resolve) => {
    const onSigint = () => {
      renderer.setSilent(false);
      renderer.write('\n');
      renderer.writeInfo(color.yellow('  Shutting down WebUI server…'));
      resolve(0);
    };
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigint);
    webuiPromise
      .then(() => {
        renderer.setSilent(false);
        process.off('SIGINT', onSigint);
        process.off('SIGTERM', onSigint);
        resolve(0);
      })
      .catch((err) => {
        renderer.setSilent(false);
        process.off('SIGINT', onSigint);
        process.off('SIGTERM', onSigint);
        console.debug(`[execution] webui error: ${err}`);
        resolve(1);
      });
  });
  return webuiExit;
}
