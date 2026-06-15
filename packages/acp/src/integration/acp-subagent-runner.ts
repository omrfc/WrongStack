/**
 * ACPSubagentRunner — SubagentRunner implementation for DIR-1.
 *
 * Wraps an external ACP agent (Cline, Gemini CLI, Codex CLI, Copilot, etc.)
 * as a WrongStack subagent. The external agent runs its own agent loop;
 * we send it a task via ACP and return the result.
 *
 * Connected to Director / MultiAgentCoordinator via the SubagentRunner
 * interface (same as AgentSubagentRunner).
 */
import type {SubagentRunContext, SubagentRunner, TaskSpec} from '@wrongstack/core';
import {ClientTransport} from '../agent/stdio-transport.js';
import type {ACPToolCallResponse} from '../types/acp-messages.js';
import {ToolTranslator, parseToolResponse} from '../client/tool-translator.js';
import type {ToolTranslatorOptions} from '../client/tool-translator.js';

export interface ACPSubagentRunnerOptions {
  /** ACP agent command or npm package (e.g. 'npx', 'gemini', 'gh') */
  command: string;
  args?: string[] | undefined;
  env?: Record<string, string>;
  cwd?: string | undefined;
  /** Subagent role — used for protocol negotiation and prompt overrides */
  role?: string | undefined;
  toolTranslatorOpts?: ToolTranslatorOptions | undefined;
}

/** Map WrongStack ACP agent role → how to spawn it. */
export const ACP_AGENT_COMMANDS: Record<string, ACPSubagentRunnerOptions> = {
  cline: {
    command: 'npx',
    args: ['-y', '@agentify/cline'],
    role: 'cline',
  },
  'gemini-cli': {
    command: 'gemini',
    role: 'gemini-cli',
  },
  copilot: {
    command: 'gh',
    args: ['copilot', 'agent'],
    role: 'copilot',
  },
  openhands: {
    command: 'openhands',
    role: 'openhands',
  },
  goose: {
    command: 'goose',
    role: 'goose',
  },
};

/**
 * Build an ACPSubagentRunner for a given role, or a generic one from explicit options.
 */
export async function makeACPSubagentRunner(
  options: ACPSubagentRunnerOptions,
): Promise<SubagentRunner> {
  const transport = new ClientTransport(clientTransportOptions(options));

  const translator = new ToolTranslator(options.toolTranslatorOpts);
  const activeAbort = new AbortController();

  let sessionStarted = false;

  const startSession = async (): Promise<void> => {
    if (sessionStarted) return;
    await transport.start();

    await transport.send({
      method: 'initialize',
      id: '1',
      params: {
        capabilities: ['code-generation', 'async-tools', 'streaming', 'progress'],
        protocolVersion: '2024-11',
        sessionId: options.role ?? 'wrongstack-subagent',
      },
    });

    const initResp = await transport.read();
    if (!initResp || initResp.error) {
      throw new Error(`ACP initialize failed: ${initResp?.error?.message ?? 'no response'}`);
    }

    translator.attachToTransport({
      onMessage: (h) => transport.onMessage(h),
      /* v8 ignore next -- translator stores but never invokes send (callTool talks to the transport directly). */
      send: (m) => transport.send(m),
    });

    sessionStarted = true;
  };

  const runner: SubagentRunner = async (
    task: TaskSpec,
    ctx: SubagentRunContext,
  ): Promise<{result?: unknown | undefined; iterations: number; toolCalls: number}> => {
    ctx.signal.addEventListener('abort', () => {
      activeAbort.abort();
      transport.stop();
    });

    await startSession();

    const callId = crypto.randomUUID();
    let toolResult: ACPToolCallResponse | null = null;

    const resultPromise = new Promise<ACPToolCallResponse>((resolve, reject) => {
      const budgetMs = ctx.budget.limits.timeoutMs ?? 300_000;

      const timeout = setTimeout(() => {
        reject(new Error(`ACP task timed out for subagent ${ctx.subagentId} (${budgetMs}ms budget)`));
      }, budgetMs);

      transport.onMessage((msg) => {
        if (msg.method === 'tools/call' && msg.id !== undefined) {
          clearTimeout(timeout);
          resolve(msg as unknown as ACPToolCallResponse);
        }
      });

      ctx.signal.addEventListener('abort', () => {
        clearTimeout(timeout);
        reject(new Error('Task aborted by parent'));
      });
    });

    try {
      // Most ACP agents accept a free-form task string as their primary input. (DIR-1)
      // Use the tools/call protocol with a special 'task' pseudo-tool if the
      // agent advertises it; otherwise send it as an initialize session detail
      // or a custom agent/run message. The agent will respond on stdout.
      await transport.send({
        method: 'agent/run',
        id: callId,
        params: {
          task: task.description,
          sessionId: ctx.subagentId,
        },
      });

      toolResult = await resultPromise;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        result: `ACP subagent error: ${msg}`,
        iterations: 0,
        toolCalls: 0,
      };
    }

    /* v8 ignore start -- defensive: resultPromise only ever resolves with a truthy message or rejects (handled above). */
    if (!toolResult) {
      return {result: 'ACP subagent returned no result', iterations: 1, toolCalls: 1};
    }
    /* v8 ignore stop */

    const parsed = parseToolResponse(task.id, ctx.subagentId, toolResult);
    return {
      /* v8 ignore next -- parseToolResponse always sets a string result; the ?? error fallback is defensive. */
      result: parsed.result ?? parsed.error,
      iterations: parsed.iterations,
      toolCalls: parsed.toolCalls,
    };
  };

  return runner;
}

/** Returns the runner and a stop function to clean up the transport. */
export async function makeACPSubagentRunnerWithStop(
  options: ACPSubagentRunnerOptions,
): Promise<{runner: SubagentRunner; stop: () => void}> {
  const transport = new ClientTransport(clientTransportOptions(options));

  const translator = new ToolTranslator(options.toolTranslatorOpts);
  const activeAbort = new AbortController();

  let sessionStarted = false;

  const startSession = async (): Promise<void> => {
    if (sessionStarted) return;
    await transport.start();

    await transport.send({
      method: 'initialize',
      id: '1',
      params: {
        capabilities: ['code-generation', 'async-tools', 'streaming', 'progress'],
        protocolVersion: '2024-11',
        sessionId: options.role ?? 'wrongstack-subagent',
      },
    });

    const initResp = await transport.read();
    if (!initResp || initResp.error) {
      throw new Error(`ACP initialize failed: ${initResp?.error?.message ?? 'no response'}`);
    }

    translator.attachToTransport({
      onMessage: (h) => transport.onMessage(h),
      /* v8 ignore next -- translator stores but never invokes send (callTool talks to the transport directly). */
      send: (m) => transport.send(m),
    });

    sessionStarted = true;
  };

  const stop = () => {
    activeAbort.abort();
    transport.stop();
  };

  const runner: SubagentRunner = async (
    task: TaskSpec,
    ctx: SubagentRunContext,
  ): Promise<{result?: unknown | undefined; iterations: number; toolCalls: number}> => {
    ctx.signal.addEventListener('abort', () => {
      activeAbort.abort();
      transport.stop();
    });

    await startSession();

    const callId = crypto.randomUUID();
    let toolResult: ACPToolCallResponse | null = null;

    const resultPromise = new Promise<ACPToolCallResponse>((resolve, reject) => {
      const budgetMs = ctx.budget.limits.timeoutMs ?? 300_000;

      const timeout = setTimeout(() => {
        reject(new Error(`ACP task timed out for subagent ${ctx.subagentId} (${budgetMs}ms budget)`));
      }, budgetMs);

      transport.onMessage((msg) => {
        if (msg.method === 'tools/call' && msg.id !== undefined) {
          clearTimeout(timeout);
          resolve(msg as unknown as ACPToolCallResponse);
        }
      });

      ctx.signal.addEventListener('abort', () => {
        clearTimeout(timeout);
        reject(new Error('Task aborted by parent'));
      });
    });

    try {
      await transport.send({
        method: 'agent/run',
        id: callId,
        params: {
          task: task.description,
          sessionId: ctx.subagentId,
        },
      });

      toolResult = await resultPromise;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        result: `ACP subagent error: ${msg}`,
        iterations: 0,
        toolCalls: 0,
      };
    }

    /* v8 ignore start -- defensive: resultPromise only ever resolves with a truthy message or rejects (handled above). */
    if (!toolResult) {
      return {result: 'ACP subagent returned no result', iterations: 1, toolCalls: 1};
    }
    /* v8 ignore stop */

    const parsed = parseToolResponse(task.id, ctx.subagentId, toolResult);
    return {
      /* v8 ignore next -- parseToolResponse always sets a string result; the ?? error fallback is defensive. */
      result: parsed.result ?? parsed.error,
      iterations: parsed.iterations,
      toolCalls: parsed.toolCalls,
    };
  };

  return {runner, stop};
}

function clientTransportOptions(options: ACPSubagentRunnerOptions): ConstructorParameters<typeof ClientTransport>[0] {
  const out: ConstructorParameters<typeof ClientTransport>[0] = {
    command: options.command,
    handshakeTimeoutMs: 30_000,
  };
  if (options.args !== undefined) out.args = options.args;
  if (options.env !== undefined) out.env = options.env;
  if (options.cwd !== undefined) out.cwd = options.cwd;
  return out;
}
