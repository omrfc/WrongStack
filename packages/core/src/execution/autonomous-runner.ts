import type { Agent, RunResult } from '../core/agent.js';
import type { Context } from '../core/context.js';
import { toWrongStackError } from '../types/errors.js';
import type { DoneCondition } from '../types/multi-agent.js';

type AutonomousResult = RunResult & { toolCalls: number; reason?: string };

export interface DoneCheckResult {
  done: boolean;
  reason?: string;
  iterations: number;
  toolCalls: number;
}

export class DoneConditionChecker {
  private readonly compiledRegex: RegExp | null;

  constructor(private readonly condition: DoneCondition) {
    this.compiledRegex =
      condition.type === 'output_match' && condition.pattern ? new RegExp(condition.pattern) : null;
  }

  check(state: { iterations: number; toolCalls: number; lastOutput?: string }): DoneCheckResult {
    switch (this.condition.type) {
      case 'iterations':
        if (this.condition.maxIterations && state.iterations >= this.condition.maxIterations) {
          return {
            done: true,
            reason: `max iterations (${this.condition.maxIterations}) reached`,
            ...state,
          };
        }
        break;

      case 'tool_calls':
        if (this.condition.maxToolCalls && state.toolCalls >= this.condition.maxToolCalls) {
          return {
            done: true,
            reason: `max tool calls (${this.condition.maxToolCalls}) reached`,
            ...state,
          };
        }
        break;

      case 'output_match':
        if (this.compiledRegex && state.lastOutput && this.compiledRegex.test(state.lastOutput)) {
          return {
            done: true,
            reason: `output matched pattern "${this.condition.pattern}"`,
            ...state,
          };
        }
        break;

      case 'custom':
        // Reserved for future extension
        break;
    }

    return { done: false, iterations: state.iterations, toolCalls: state.toolCalls };
  }
}

export interface AutonomousRunnerOptions {
  agent: Agent;
  context: Context;
  doneCondition: DoneCondition;
  iterationTimeoutMs?: number;
  onIteration?: (state: { iteration: number; toolCalls: number }) => void;
  onDone?: (result: AutonomousResult) => void;
}

export class AutonomousRunner {
  private iterations = 0;
  private toolCalls = 0;
  private lastOutput?: string;
  private stopped = false;
  private readonly doneChecker: DoneConditionChecker;

  constructor(private readonly opts: AutonomousRunnerOptions) {
    this.doneChecker = new DoneConditionChecker(opts.doneCondition);
  }

  async run(): Promise<AutonomousResult> {
    // Subscribe to `tool.executed` so the per-tool budget (`tool_calls`
    // done-condition) actually counts each tool invocation rather than
    // each `agent.run()` call. Without this, a single iteration that
    // fires 5 tools only bumps the counter once, and a `maxToolCalls: 3`
    // budget would fire after 3 iterations (typically 3×N tools) instead
    // of after 3 tools. Unsubscribed in the `finally` so the listener
    // doesn't outlive this run instance. Mock agents in tests may pass
    // null/undefined for `events`; gracefully skip when missing — those
    // tests don't exercise the tool-count budget path.
    const offToolExecuted = this.opts.agent.events?.on?.('tool.executed', () => {
      this.toolCalls++;
    });
    try {
      return await this.runLoop();
    } finally {
      offToolExecuted?.();
    }
  }

  private async runLoop(): Promise<AutonomousResult> {
    while (!this.stopped) {
      const check = this.doneChecker.check({
        iterations: this.iterations,
        toolCalls: this.toolCalls,
        lastOutput: this.lastOutput,
      });

      if (check.done) {
        const result: AutonomousResult = {
          status: 'done',
          iterations: this.iterations,
          toolCalls: this.toolCalls,
          reason: check.reason,
        };
        this.opts.onDone?.(result);
        return result;
      }

      this.opts.onIteration?.({ iteration: this.iterations, toolCalls: this.toolCalls });

      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), this.opts.iterationTimeoutMs ?? 30_000);

      try {
        const result = await this.opts.agent.run('', {
          signal: ctrl.signal,
          maxIterations: 1,
          executionStrategy: 'sequential',
        });

        this.iterations++;
        // Only access finalText when the run actually succeeded. Failed/aborted
        // runs may have undefined finalText — accessing it unconditionally would
        // produce garbage output for the done-condition matchers.
        if (result.status === 'done') {
          this.lastOutput = result.finalText;
        }
        // `toolCalls` is bumped by the `tool.executed` listener installed
        // in run() — no manual increment here.

        if (result.status === 'failed' || result.status === 'aborted') {
          const failedResult: AutonomousResult = {
            status: result.status,
            error: result.error,
            iterations: this.iterations,
            toolCalls: this.toolCalls,
          };
          this.opts.onDone?.(failedResult);
          return failedResult;
        }
      } catch (e) {
        // Be precise about what constitutes a timeout error — matching on
        // 'timeout' substring is too loose (an error message containing
        // "timeout exceeded" from the LLM is not the same as an abort).
        const isAbort =
          (e instanceof DOMException && e.name === 'AbortError') ||
          (e instanceof Error && e.name === 'AbortError') ||
          (e instanceof Error && e.message.includes('iteration timeout'));
        if (isAbort) {
          const timeoutResult: AutonomousResult = {
            status: 'failed',
            error: toWrongStackError(e),
            iterations: this.iterations,
            toolCalls: this.toolCalls,
            reason: 'iteration timeout',
          };
          this.opts.onDone?.(timeoutResult);
          return timeoutResult;
        }
        // Any other throw (TypeError, tool crash propagation, etc.) must
        // stop the loop — silently continuing would spin forever on the
        // same error and burn provider tokens with no progress.
        this.stopped = true;
        const failedResult: AutonomousResult = {
          status: 'failed',
          error: toWrongStackError(e),
          iterations: this.iterations,
          toolCalls: this.toolCalls,
          reason: e instanceof Error ? e.message : String(e),
        };
        this.opts.onDone?.(failedResult);
        return failedResult;
      } finally {
        clearTimeout(timeout);
      }
    }

    return {
      status: 'aborted',
      iterations: this.iterations,
      toolCalls: this.toolCalls,
      reason: 'stopped externally',
    };
  }

  stop(): void {
    this.stopped = true;
  }
}
