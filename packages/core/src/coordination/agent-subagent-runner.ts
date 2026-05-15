import type { Agent, AgentInput, RunResult } from '../core/agent.js';
import type { EventBus } from '../kernel/events.js';
import type {
  SubagentConfig,
  SubagentRunContext,
  SubagentRunOutcome,
  SubagentRunner,
  TaskSpec,
} from '../types/multi-agent.js';
import { BudgetExceededError } from './subagent-budget.js';

/**
 * Caller-supplied factory that builds an isolated `Agent` for a subagent.
 * The factory MUST construct a fresh `Context` per call — sharing context
 * between subagents defeats isolation. Each Agent should also use either
 * its own `EventBus` or a forwarded view, so per-subagent metrics can be
 * attributed correctly.
 */
export type AgentFactory = (config: SubagentConfig) => Promise<AgentFactoryResult>;

export interface AgentFactoryResult {
  agent: Agent;
  /** Event bus the factory wired to this agent — required for budget hookup. */
  events: EventBus;
}

export interface AgentRunnerOptions {
  factory: AgentFactory;
  /**
   * Format a TaskSpec into the user input the agent will receive. Defaults
   * to `task.description ?? ''`. Override when subagents expect structured
   * input (e.g. JSON contracts, role-prefixed prompts).
   */
  formatTaskInput?: (task: TaskSpec, config: SubagentConfig) => AgentInput;
}

/**
 * Builds a `SubagentRunner` that drives a real `Agent` per task while honoring
 * the coordinator's budget and abort signal. This is the production adapter —
 * the coordinator's `runner` option in CLI/TUI assemblies points here.
 *
 * Lifecycle per task:
 *   1. factory(config) → fresh Agent + EventBus.
 *   2. Subscribe to events to feed the budget (tool calls, token usage).
 *   3. Call agent.run(input, { signal }) — the coordinator's signal cancels.
 *   4. Map RunResult.status onto a `SubagentRunOutcome` or throw on failure.
 *   5. Unsubscribe and let the factory's resources be GC'd.
 *
 * The budget is checked synchronously from event handlers — a runaway agent
 * that crosses its tool-call limit triggers `BudgetExceededError`, which the
 * coordinator surfaces as `status: 'failed'` on the task result.
 */
export function makeAgentSubagentRunner(opts: AgentRunnerOptions): SubagentRunner {
  const format = opts.formatTaskInput ?? defaultFormatTaskInput;

  return async (task: TaskSpec, ctx: SubagentRunContext): Promise<SubagentRunOutcome> => {
    const { agent, events } = await opts.factory(ctx.config);

    // Hook budget into the agent's event stream. We capture errors thrown by
    // recordToolCall/recordUsage so the budget can short-circuit the run by
    // aborting the controller — the agent then unwinds cooperatively.
    const aborter = new AbortController();
    let budgetError: BudgetExceededError | null = null;

    const onBudgetError = (err: unknown) => {
      // Any error from a budget operation (BudgetExceededError, TypeError from
      // a malformed event payload, etc.) must abort the run. EventBus.emit()
      // swallows listener throws, so we can't re-throw — set budgetError and
      // abort the controller so the agent unwinds cooperatively.
      aborter.abort();
      budgetError =
        err instanceof BudgetExceededError
          ? err
          : new BudgetExceededError(
              'tool_calls',
              0,
              0,
            );
      // Attach the real error detail so the task result surfaces
      // something actionable instead of a generic budget message.
      if (budgetError !== err && err instanceof Error) {
        budgetError.message += ` (caused by: ${err.message})`;
      }
    };

    const unsub: Array<() => void> = [];
    unsub.push(
      events.on('tool.started', () => {
        try {
          ctx.budget.recordToolCall();
        } catch (e) {
          onBudgetError(e);
        }
      }),
      events.on('provider.response', (e) => {
        try {
          ctx.budget.recordUsage(e.usage);
        } catch (e2) {
          onBudgetError(e2);
        }
      }),
      events.on('iteration.started', () => {
        try {
          ctx.budget.recordIteration();
          ctx.budget.checkTimeout();
        } catch (e) {
          onBudgetError(e);
        }
      }),
    );

    // Forward the coordinator signal so stop() from outside also aborts.
    const onParentAbort = () => aborter.abort();
    ctx.signal.addEventListener('abort', onParentAbort);

    let result: RunResult;
    try {
      result = await agent.run(format(task, ctx.config), { signal: aborter.signal });
    } finally {
      ctx.signal.removeEventListener('abort', onParentAbort);
      for (const u of unsub) u();
    }

    // A budget violation is the signal — surface it so the coordinator can
    // tag the task with the right failure kind ('failed' for budget; the
    // coordinator separately recognises 'timeout' from BudgetExceededError).
    if (budgetError) throw budgetError;

    if (result.status === 'failed') {
      throw result.error instanceof Error
        ? result.error
        : new Error(String(result.error ?? 'agent failed'));
    }
    // 'aborted' and 'max_iterations' aren't successes — let the coordinator
    // classify them. When the parent signal was aborted, coordinator marks
    // the task 'stopped' (matched against subagent.abortController.aborted).
    if (result.status === 'aborted') {
      throw new Error('agent aborted');
    }
    if (result.status === 'max_iterations') {
      throw new Error('agent exhausted iteration limit');
    }

    const usage = ctx.budget.usage();
    return {
      result: result.finalText,
      iterations: result.iterations,
      toolCalls: usage.toolCalls,
    };
  };
}

function defaultFormatTaskInput(task: TaskSpec): AgentInput {
  return task.description ?? '';
}
