/**
 * ACP CLI integration.
 *
 * Two modes:
 *   `wstack acp`              — start WrongStack as an ACP server (blocks)
 *   `wstack acp <agent-name>` — spawn an ACP agent as a subagent  [future]
 *
 * DIR-2: `wstack acp` runs WrongStack as a standard-compliant ACP agent.
 * ACP clients (Zed, JetBrains, VS Code ACP extension) spawn it as a subprocess.
 * This is the correct CLI entry point to test DIR-2 against a real ACP client.
 */

import {
  ACP_AGENT_COMMANDS,
  EnsembleRegistry,
  makeACPSubagentRunnerWithStop,
} from '@wrongstack/acp';
import { WrongStackACPServer } from '@wrongstack/acp/agent';
import type { SubagentRunContext } from '@wrongstack/core';
import { SubagentBudget } from '@wrongstack/core/coordination';
import type { SubcommandDeps, SubcommandHandler } from '../index.js';

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
  wstack acp help         Show this help

ACP Mode:
  When run as \`wstack acp\`. WrongStack acts as an ACP-compatible agent.
  ACP clients (Zed, JetBrains, VS Code) spawn it as a subprocess and
  communicate over stdio JSON-RPC.
  Press Ctrl+C to stop.

spawn:
  Spawns a named ACP agent (cline, gemini-cli, copilot, openhands, goose)
  with the given task and waits for its result.
  Example: wstack acp spawn cline "fix the login bug"
`);
    return 0;
  }

  if (sub === 'list') {
    return listACPAgents(deps);
  }

  if (sub === 'spawn') {
    return spawnACPAgent(args.slice(1), deps);
  }

  deps.renderer.writeError(`Unknown acp subcommand: ${sub}\n`);
  deps.renderer.write('Run `wstack acp help` for usage.\n');
  return 1;
};

async function runACPServer(deps: SubcommandDeps): Promise<number> {
  const toolRegistry = deps.toolRegistry;
  const tools = toolRegistry?.list() ?? [];

  deps.renderer.writeInfo('Starting WrongStack ACP server...\n');
  deps.renderer.writeInfo(`Exposing ${tools.length} tool(s) via ACP protocol.\n`);
  deps.renderer.writeInfo('Waiting for ACP client connection on stdin/stdout...\n');
  deps.renderer.writeInfo('Press Ctrl+C to stop.\n');

  const server = new WrongStackACPServer({ tools });

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

  const cmd = ACP_AGENT_COMMANDS[subagentId];
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
    const { runner, stop: runStop } = await makeACPSubagentRunnerWithStop(cmd);
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
