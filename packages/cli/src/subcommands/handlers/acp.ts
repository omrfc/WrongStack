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
  EnsembleRegistry,
  findAgentDescriptor,
  makeACPSubagentRunnerWithStop,
} from '@wrongstack/acp';
import { WrongStackACPServer } from '@wrongstack/acp/agent';
import type { SubagentRunContext } from '@wrongstack/core';
import { SubagentBudget } from '@wrongstack/core/coordination';
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
  When run as \`wstack acp\`. WrongStack acts as an ACP-compatible agent.
  ACP clients (Zed, JetBrains, VS Code) spawn it as a subprocess and
  communicate over stdio JSON-RPC.
  Press Ctrl+C to stop.

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

async function runACPServer(deps: SubcommandDeps): Promise<number> {
  deps.renderer.writeInfo('Starting WrongStack ACP server...\n');
  deps.renderer.writeInfo('Waiting for ACP client connection on stdin/stdout...\n');
  deps.renderer.writeInfo('(default runTurn is a no-op echo — wire makeACPServerAgentTurn for a real agent)\n');
  deps.renderer.writeInfo('Press Ctrl+C to stop.\n');

  const server = new WrongStackACPServer({});

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

/**
 * One-shot runner for a single agent — used by both `spawn` and `parallel`.
 * Returns a structured outcome that the caller can render however it wants.
 * Throws only on programmer errors (missing id, missing task); all agent
 * failures are reported as `{status: 'failed', error}`.
 */
async function runOneACP(
  subagentId: string,
  task: string,
  deps: SubcommandDeps,
  renderInPlace: boolean,
): Promise<
  | { status: 'success'; result: unknown; iterations: number; toolCalls: number; durationMs: number }
  | { status: 'failed'; error: { kind: string; message: string }; durationMs: number }
> {
  const cmd = ACP_AGENT_COMMANDS[subagentId] ?? resolveCmdFromCatalog(subagentId);
  if (!cmd) {
    return {
      status: 'failed',
      error: { kind: 'unknown_agent', message: `Unknown ACP agent: ${subagentId}` },
      durationMs: 0,
    };
  }

  const startedAt = Date.now();
  const { runner, stop } = await makeACPSubagentRunnerWithStop(cmd);

  try {
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
    if (renderInPlace) {
      deps.renderer.writeInfo(`Running task on ${subagentId}…\n`);
    }
    const result = await runner({ id: taskId, description: task }, ctx);
    return {
      status: 'success',
      result: result.result,
      iterations: result.iterations,
      toolCalls: result.toolCalls,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const e = err as { kind?: string; message?: string };
    return {
      status: 'failed',
      error: {
        kind: e.kind ?? 'unknown',
        message: e.message ?? (err instanceof Error ? err.message : String(err)),
      },
      durationMs: Date.now() - startedAt,
    };
  } finally {
    try {
      stop();
    } catch {
      /* ignore */
    }
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

  // Dedup, preserve order, drop empty entries.
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const raw of csv.split(',')) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) {
    deps.renderer.writeError('No agent ids provided.\n');
    return 1;
  }

  // Probe the registry to surface install issues up-front.
  const registry = new EnsembleRegistry();
  const detected = await registry.list();
  const detectedById = new Map(detected.map((a) => [a.id, a]));
  const available: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of ids) {
    const d = detectedById.get(id);
    if (d && d.installed) {
      available.push(id);
    } else {
      skipped.push({ id, reason: d?.reason ?? 'not in catalog' });
    }
  }

  if (skipped.length > 0) {
    deps.renderer.writeWarning(
      `Skipping ${skipped.length} agent(s) not installed: ${skipped.map((s) => `${s.id} (${s.reason})`).join(', ')}\n`,
    );
  }
  if (available.length === 0) {
    deps.renderer.writeError('No installed agents to run.\n');
    deps.renderer.write('Run `wstack acp list` to see what is available.\n');
    return 1;
  }

  deps.renderer.writeInfo(
    `Fanning out to ${available.length} agent(s): ${available.join(', ')}\n`,
  );
  deps.renderer.writeInfo(`Task: ${task}\n\n`);

  // Stop everything on signal. Track each runner's stop function.
  const onSignal = () => {
    // The runner's stop is called in runOneACP's finally; SIGINT will be
    // handled by each child process terminating naturally. The
    // Promise.allSettled resolves once all children have exited.
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const settled = await Promise.allSettled(
    available.map((id) => runOneACP(id, task, deps, true)),
  );

  // Render each result under a clear header, in input order.
  let successCount = 0;
  let failCount = 0;
  for (let i = 0; i < available.length; i++) {
    const id = available[i]!;
    const s = settled[i]!;
    deps.renderer.write(`\n=== ${id} ===\n`);
    if (s.status === 'rejected') {
      failCount++;
      const reason = s.reason instanceof Error ? s.reason.message : String(s.reason);
      deps.renderer.writeError(`Crashed: ${reason}\n`);
      continue;
    }
    const r = s.value;
    if (r.status === 'success') {
      successCount++;
      deps.renderer.write(String(r.result ?? '(no result)'));
      deps.renderer.write(
        `\n[${id}] success  ${r.durationMs}ms  iterations=${r.iterations} toolCalls=${r.toolCalls}\n`,
      );
    } else {
      failCount++;
      deps.renderer.writeError(
        `[${r.error.kind}] ${r.error.message}\n`,
      );
      deps.renderer.write(
        `[${id}] failed  ${r.durationMs}ms\n`,
      );
    }
  }

  deps.renderer.write(
    `\nParallel summary: ${successCount} succeeded, ${failCount} failed, ${skipped.length} skipped.\n`,
  );

  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);

  // 0 if at least one agent succeeded, 1 if all failed.
  return successCount > 0 ? 0 : 1;
}
