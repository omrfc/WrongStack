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
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Subagent role — used for protocol negotiation and prompt overrides */
  role?: string;
  toolTranslatorOpts?: ToolTranslatorOptions;
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
  const transport = new ClientTransport({
    command: options.command,
    args: options.args,
    env: options.env,
    cwd: options.cwd,
    handshakeTimeoutMs: 30_000,
  });

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
      send: (m) => transport.send(m),
    });

    sessionStarted = true;
  };

  const runner: SubagentRunner = async (
    task: TaskSpec,
    ctx: SubagentRunContext,
  ): Promise<{result?: unknown; iterations: number; toolCalls: number}> => {
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
      // Most ACP agents accept a free-form task string as their primary input.
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

    if (!toolResult) {
      return {result: 'ACP subagent returned no result', iterations: 1, toolCalls: 1};
    }

    const parsed = parseToolResponse(task.id, ctx.subagentId, toolResult);
    return {
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
  const transport = new ClientTransport({
    command: options.command,
    args: options.args,
    env: options.env,
    cwd: options.cwd,
    handshakeTimeoutMs: 30_000,
  });

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
  ): Promise<{result?: unknown; iterations: number; toolCalls: number}> => {
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

    if (!toolResult) {
      return {result: 'ACP subagent returned no result', iterations: 1, toolCalls: 1};
    }

    const parsed = parseToolResponse(task.id, ctx.subagentId, toolResult);
    return {
      result: parsed.result ?? parsed.error,
      iterations: parsed.iterations,
      toolCalls: parsed.toolCalls,
    };
  };

  return {runner, stop};
}
