/**
 * ACP CLI integration.
 *
 * `wstack acp`                  — start WrongStack as an ACP server (blocks)
 * `wstack acp list`             — list ACP agents installed on $PATH
 * `wstack acp spawn <id> <task>`      — run a task on one named ACP agent
 * `wstack acp parallel <csv> <task>`  — fan a task out to multiple agents
 *
 * DIR-2: `wstack acp` runs WrongStack as a standard-compliant ACP agent.
 * ACP clients (Zed, JetBrains, VS Code ACP extension) spawn it as a subprocess.
 * This is the correct CLI entry point to test DIR-2 against a real ACP client.
 */

import {
  ACP_AGENT_COMMANDS,
  type ACPProgressEvent,
  EnsembleRegistry,
  findAgentDescriptor,
  makeACPSubagentRunnerWithStop,
  runEnsemble,
} from '@wrongstack/acp';
import {
  ACPProtocolHandler,
  ACPSessionStore,
  makeACPServerAgentTurn,
  type RunTurn,
  WrongStackACPServer,
  WsBridgeTransport,
} from '@wrongstack/acp/agent';
import * as path from 'node:path';
import { WebSocketServer } from 'ws';
import type { SubagentRunContext } from '@wrongstack/core';
import { SubagentBudget } from '@wrongstack/core/coordination';
import { AcpServerConfigError, buildAcpServerAgentFactory } from '../../acp-server-agent.js';
import type { SubcommandDeps, SubcommandHandler } from '../index.js';

/**
 * Fallback: if an agent id is in the 12-entry catalog but not in the legacy
 * 5-entry `ACP_AGENT_COMMANDS` map, build a command from the catalog entry.
 * The legacy map is kept for backward compatibility but the catalog is the
 * source of truth for what's actually supported.
 */
function resolveCmdFromCatalog(
  subagentId: string,
): { command: string; args: string[]; env?: Record<string, string>; role?: string } | null {
  const desc = findAgentDescriptor(subagentId);
  if (!desc) return null;
  const out: { command: string; args: string[]; env?: Record<string, string>; role?: string } = {
    command: desc.acp.command,
    args: [...(desc.acp.args ?? [])],
    role: subagentId,
  };
  if (desc.acp.env) out.env = desc.acp.env;
  return out;
}

export const acpCmd: SubcommandHandler = async (args, deps) => {
  const sub = args[0];

  if (!sub || sub === 'server' || sub === 'serve') {
    return runACPServer(deps);
  }

  if (sub === 'help') {
    deps.renderer.write(`\
wstack acp — ACP (Agent Client Protocol) integration

Usage:
  wstack acp              Start WrongStack as an ACP server (blocks)
  wstack acp server       Same as above
  wstack acp list         List available ACP agents
  wstack acp spawn <id> <task>
                        Spawn an ACP agent as a subagent and wait for result
  wstack acp parallel <agent-id-csv> <task>
                        Fan a task out to multiple ACP agents in parallel
                        and aggregate the results
  wstack acp help         Show this help

ACP Mode:
  When run as \`wstack acp\`. WrongStack acts as an ACP-compatible agent driven
  by your configured model provider. ACP clients (Zed, JetBrains, VS Code)
  spawn it as a subprocess and communicate over stdio JSON-RPC. Run
  \`wstack auth\` first to configure a provider, or pass \`--echo\` for a no-op
  connectivity test that needs no provider. Press Ctrl+C to stop.

  Transports:
    (default)        stdio JSON-RPC (the usual editor-spawned-subprocess mode)
    --ws[=port]      serve over WebSocket on 127.0.0.1:<port> (default 8889) —
                     full-duplex, so updates/permission prompts stream live.

spawn:
  Spawns a named ACP agent (claude-code, gemini-cli, codex-cli, copilot,
  cline, goose, openhands, qwen-code, kiro-cli, opencode, mistral-vibe,
  cursor) with the given task and waits for its result.
  Example: wstack acp spawn cline "fix the login bug"

parallel:
  Runs the same task on a comma-separated list of ACP agents concurrently.
  Example: wstack acp parallel claude-code,gemini-cli,codex-cli "review this diff"
  Each agent's result is rendered under a clearly-marked header. Returns 0
  if at least one agent succeeds, 1 if all fail. Agents that aren't
  installed are skipped with a warning.
`);
    return 0;
  }

  if (sub === 'list') {
    return listACPAgents(deps);
  }

  if (sub === 'spawn') {
    return spawnACPAgent(args.slice(1), deps);
  }

  if (sub === 'parallel') {
    return parallelACPAgents(args.slice(1), deps);
  }

  deps.renderer.writeError(`Unknown acp subcommand: ${sub}\n`);
  deps.renderer.write('Run `wstack acp help` for usage.\n');
  return 1;
};

/** Parse the `--ws[=port]` flag into a port number, or null if not set. */
function parseWsPort(flag: unknown): number | null {
  if (flag === undefined || flag === false) return null;
  if (flag === true || flag === 'true') return 8889;
  const n = Number(flag);
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : 8889;
}

/**
 * Serve WrongStack as an ACP agent over WebSocket. Unlike the HTTP transport
 * (one POST per message, notifications buffered), a WebSocket is full-duplex:
 * the agent streams `session/update` and makes `session/request_permission`
 * callbacks live during a turn. One handler + transport per connection.
 */
async function runACPWebSocketServer(deps: SubcommandDeps, port: number): Promise<number> {
  const host = '127.0.0.1';
  // `--echo` over WS: a no-provider connectivity test, mirroring stdio `--echo`.
  const echo = deps.flags?.echo === true || deps.flags?.echo === 'true';

  let turn: ReturnType<typeof makeACPServerAgentTurn> | undefined;
  let echoTurn: RunTurn | undefined;
  let store: ACPSessionStore | undefined;
  if (echo) {
    echoTurn = async () => ({ stopReason: 'end_turn' });
  } else {
    let agentFor;
    try {
      agentFor = buildAcpServerAgentFactory(deps);
    } catch (err) {
      if (err instanceof AcpServerConfigError) {
        deps.renderer.writeError(`${err.message}\n`);
        return 1;
      }
      throw err;
    }
    turn = makeACPServerAgentTurn({ agentFor });
    store = deps.paths?.projectDir
      ? new ACPSessionStore({ dir: path.join(deps.paths.projectDir, 'acp-sessions') })
      : undefined;
  }

  const wss = new WebSocketServer({ host, port });
  wss.on('connection', (socket, req) => {
    // Origin guard: real ACP clients send no Origin; reject cross-origin
    // browser connections so a web page can't drive this loopback agent.
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}:${port}` && origin !== `ws://${host}:${port}`) {
      socket.close(1008, 'cross-origin forbidden');
      return;
    }
    const transport = new WsBridgeTransport((m) => socket.send(JSON.stringify(m)));
    const handler = new ACPProtocolHandler({
      transport,
      defaultCwd: deps.cwd ?? process.cwd(),
      runTurn: turn ?? echoTurn!,
      ...(turn ? { replayFor: turn.replay, seedFor: turn.seed } : {}),
      ...(store ? { store } : {}),
    });
    socket.on('message', (data: { toString(): string }) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      transport.receive(msg as never);
      void handler.handleMessage(msg);
    });
    const teardown = (): void => {
      handler.close();
      transport.close();
    };
    socket.on('close', teardown);
    socket.on('error', teardown);
  });

  deps.renderer.writeInfo(
    echo
      ? `ACP server (echo, no provider) listening on ws://${host}:${port}. Press Ctrl+C to stop.\n`
      : `WrongStack ACP server listening on ws://${host}:${port} (${deps.config.provider}/${deps.config.model}). Press Ctrl+C to stop.\n`,
  );

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      deps.renderer.writeWarning('\nShutting down ACP WebSocket server...');
      wss.close();
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
  return 0;
}

async function runACPServer(deps: SubcommandDeps): Promise<number> {
  const wsPort = parseWsPort(deps.flags?.ws);
  if (wsPort !== null) {
    return runACPWebSocketServer(deps, wsPort);
  }
  // `--echo` keeps the no-op connectivity-smoke-test path that the default
  // runTurn provided before this server was wired to a real Agent. Useful for
  // `wstack acp --echo` when you just want to verify the wire format against a
  // client without needing a configured provider.
  const echo = deps.flags?.echo === true || deps.flags?.echo === 'true';

  const server = new WrongStackACPServer(
    echo
      ? {}
      : (() => {
          let agentFor;
          try {
            agentFor = buildAcpServerAgentFactory(deps);
          } catch (err) {
            if (err instanceof AcpServerConfigError) {
              deps.renderer.writeError(`${err.message}\n`);
              return {};
            }
            throw err;
          }
          const turn = makeACPServerAgentTurn({ agentFor });
          // Persist sessions under the project's wstack dir so `session/load`
          // survives a server restart (project-scoped, not in the repo).
          const store = deps.paths?.projectDir
            ? new ACPSessionStore({ dir: path.join(deps.paths.projectDir, 'acp-sessions') })
            : undefined;
          return {
            runTurn: turn,
            replayFor: turn.replay,
            seedFor: turn.seed,
            ...(store ? { store } : {}),
          };
        })(),
  );

  if (echo) {
    deps.renderer.writeInfo('ACP server starting in --echo mode (no-op turn; no provider needed).\n');
  } else {
    deps.renderer.writeInfo(
      `Starting WrongStack ACP server (${deps.config.provider}/${deps.config.model})…\n`,
    );
    deps.renderer.writeInfo('Waiting for an ACP client connection on stdin/stdout. Press Ctrl+C to stop.\n');
  }

  const shutdown = () => {
    deps.renderer.writeWarning('\nShutting down ACP server...');
    server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await server.start();
  } catch (err) {
    deps.renderer.writeError(
      `ACP server error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  return 0;
}

async function listACPAgents(deps: SubcommandDeps): Promise<number> {
  const registry = new EnsembleRegistry();
  const detected = await registry.list();
  deps.renderer.write('Detected ACP agents:\n\n');
  // Print installed first, then not-installed with a "not installed" note.
  const installed = detected.filter((a) => a.installed);
  const missing = detected.filter((a) => !a.installed);
  for (const a of installed) {
    const ver = a.version ? `  (${a.version.split('\n')[0]})` : '';
    deps.renderer.write(`  ✓ ${a.id.padEnd(16)} ${a.displayName}${ver}\n`);
  }
  for (const a of missing) {
    deps.renderer.write(`  ✗ ${a.id.padEnd(16)} ${a.displayName}  (${a.reason ?? 'not installed'})\n`);
  }
  deps.renderer.write(`\n${installed.length} of ${detected.length} agents available.\n`);
  deps.renderer.write('Use `wstack acp spawn <agent-id> <task>` to delegate a task.\n');
  return 0;
}

async function spawnACPAgent(args: string[], deps: SubcommandDeps): Promise<number> {
  const [subagentId, ...taskParts] = args;
  if (!subagentId) {
    deps.renderer.writeError('Usage: wstack acp spawn <agent-id> <task>\n');
    deps.renderer.write('Run `wstack acp list` to see available agents.\n');
    return 1;
  }

  const task = taskParts.join(' ');
  if (!task) {
    deps.renderer.writeError('Usage: wstack acp spawn <agent-id> <task>\n');
    deps.renderer.write('Task description is required.\n');
    return 1;
  }

  const cmd = ACP_AGENT_COMMANDS[subagentId] ?? resolveCmdFromCatalog(subagentId);
  if (!cmd) {
    deps.renderer.writeError(`Unknown ACP agent: ${subagentId}\n`);
    deps.renderer.write('Run `wstack acp list` to see available agents.\n');
    return 1;
  }

  deps.renderer.writeInfo(`Spawning ACP agent '${subagentId}'…\n`);

  const cleanup = () => {
    if (stop) {
      try {
        stop();
      } catch {
        /* ignore */
      }
    }
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  let stop: (() => void) | null = null;

  try {
    const { runner, stop: runStop } = await makeACPSubagentRunnerWithStop({
      ...cmd,
      onProgress: (event) => {
        const line = formatProgress(event);
        if (line) deps.renderer.writeInfo(`  ${line}\n`);
      },
    });
    stop = runStop;

    const taskId = `acp-${crypto.randomUUID()}`;
    const budget = new SubagentBudget({
      timeoutMs: 5 * 60 * 1000,
      maxIterations: 2000,
      maxToolCalls: 5000,
    });

    const ctx: SubagentRunContext = {
      subagentId,
      config: {
        id: subagentId,
        name: cmd.role ?? subagentId,
        role: subagentId,
        provider: 'acp',
        prompt: '',
      },
      budget,
      signal: new AbortController().signal,
      bridge: null,
    };

    budget.start();

    deps.renderer.writeInfo('Running task…\n');

    const result = await runner({ id: taskId, description: task }, ctx);

    deps.renderer.write('\n--- Result ---\n');
    deps.renderer.write(String(result.result ?? 'no result'));
    deps.renderer.write('\n---------------\n');
    deps.renderer.writeInfo(
      `Done. iterations=${result.iterations} toolCalls=${result.toolCalls}\n`,
    );
    return 0;
  } catch (err) {
    // The runner throws structured SubagentError shapes; surface the
    // `kind` for clarity (e.g. aborted_by_parent, bridge_failed).
    const e = err as { kind?: string; message?: string };
    const detail = e.kind ? `[${e.kind}] ` : '';
    const message = e.message ?? (err instanceof Error ? err.message : String(err));
    deps.renderer.writeError(`ACP agent error: ${detail}${message}\n`);
    return 1;
  } finally {
    cleanup();
    process.off('SIGINT', cleanup);
    process.off('SIGTERM', cleanup);
  }
}

/**
 * Render one streamed ACP progress event as a compact one-line summary
 * for the CLI. Returns '' for events that shouldn't print a line (the
 * final assistant text is already shown in the result block, so we skip
 * `message`/`raw` to avoid double-printing).
 */
function formatProgress(event: ACPProgressEvent): string {
  switch (event.type) {
    case 'tool_call':
      return `▸ ${event.toolCall.title} (${event.toolCall.status})`;
    case 'tool_call_update':
      return event.toolCall.status === 'completed' || event.toolCall.status === 'failed'
        ? `  ↳ ${event.toolCall.title}: ${event.toolCall.status}`
        : '';
    case 'diff':
      return `✎ ${event.diff.path}${event.diff.oldText === null ? ' (new)' : ''}`;
    case 'plan':
      return `☰ plan: ${event.entries.length} step(s)`;
    default:
      return '';
  }
}

async function parallelACPAgents(
  args: string[],
  deps: SubcommandDeps,
): Promise<number> {
  const [csv, ...taskParts] = args;
  if (!csv) {
    deps.renderer.writeError('Usage: wstack acp parallel <agent-id-csv> <task>\n');
    deps.renderer.write('Example: wstack acp parallel claude-code,gemini-cli "review this diff"\n');
    return 1;
  }
  const task = taskParts.join(' ');
  if (!task) {
    deps.renderer.writeError('Usage: wstack acp parallel <agent-id-csv> <task>\n');
    deps.renderer.writeError('Task description is required.\n');
    return 1;
  }

  // Forward SIGINT to abort the run. Each child process tears down in
  // its own finally; the AbortController propagates into the agent.
  const ac = new AbortController();
  const onSignal = () => ac.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const result = await runEnsemble({
      agentIds: csv,
      task,
      resolveCmd: resolveCmdFromCatalog,
      signal: ac.signal,
      onProgress: (agentId, event) => {
        const line = formatProgress(event);
        if (line) deps.renderer.writeInfo(`  [${agentId}] ${line}\n`);
      },
    });

    // Surface skipped agents up-front, before the per-agent output.
    const skipped = result.results.filter((r) => r.status === 'skipped');
    if (skipped.length > 0) {
      deps.renderer.writeWarning(
        `Skipping ${skipped.length} agent(s) not installed: ${skipped.map((s) => `${s.agentId} (${s.reason ?? 'not installed'})`).join(', ')}\n`,
      );
    }
    if (result.summary.succeeded + result.summary.failed + result.summary.cancelled === 0) {
      deps.renderer.writeError('No installed agents to run.\n');
      deps.renderer.write('Run `wstack acp list` to see what is available.\n');
      return 1;
    }

    const fannedOut = result.results
      .filter((r) => r.status !== 'skipped')
      .map((r) => r.agentId)
      .join(', ');
    deps.renderer.writeInfo(
      `Fanning out to ${result.summary.succeeded + result.summary.failed + result.summary.cancelled} agent(s): ${fannedOut}\n`,
    );
    deps.renderer.writeInfo(`Task: ${result.task}\n\n`);

    // Render each result under a clear header, in input order.
    for (const r of result.results) {
      if (r.status === 'skipped') continue;
      deps.renderer.write(`\n=== ${r.agentId} ===\n`);
      if (r.status === 'success') {
        deps.renderer.write(r.result && r.result.length > 0 ? r.result : '(no result)');
        deps.renderer.write(
          `\n[${r.agentId}] success  ${r.durationMs}ms  iterations=${r.iterations} toolCalls=${r.toolCalls}\n`,
        );
      } else if (r.status === 'failed') {
        deps.renderer.writeError(
          `[${r.error?.kind ?? 'unknown'}] ${r.error?.message ?? 'failed'}\n`,
        );
        deps.renderer.write(
          `[${r.agentId}] failed  ${r.durationMs}ms\n`,
        );
      } else {
        // cancelled
        deps.renderer.writeError(
          `[${r.error?.kind ?? 'aborted'}] ${r.error?.message ?? 'cancelled'}\n`,
        );
        deps.renderer.write(
          `[${r.agentId}] cancelled  ${r.durationMs}ms\n`,
        );
      }
    }

    const { succeeded, failed, cancelled, skipped: skip } = result.summary;
    deps.renderer.write(
      `\nParallel summary: ${succeeded} succeeded, ${failed} failed, ${cancelled} cancelled, ${skip} skipped.\n`,
    );

    // 0 if at least one agent succeeded, 1 otherwise.
    return succeeded > 0 ? 0 : 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
