import type { Agent, AgentInput, RunResult } from '../core/agent.js';
import type { EventBus } from '../kernel/events.js';
import type {
  SubagentConfig,
  SubagentRunContext,
  SubagentRunOutcome,
  SubagentRunner,
  TaskSpec,
} from '../types/multi-agent.js';
import {
  BudgetExceededError,
  BudgetThresholdDecision,
  BudgetThresholdSignal,
} from './subagent-budget.js';
import type { FleetBus } from './fleet-bus.js';

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
  /**
   * Optional cleanup hook invoked in the runner's `finally` block once
   * the task ends (success, failure, abort — same exit path). Factories
   * that own resources scoped to a single task (per-subagent JSONL
   * writers, transient providers, throwaway containers) implement this
   * to close them deterministically instead of relying on GC. Errors
   * thrown here are swallowed so a flaky cleanup can't mask the task's
   * real result.
   */
  dispose?: () => Promise<void> | void;
}

export interface AgentRunnerOptions {
  factory: AgentFactory;
  /**
   * Format a TaskSpec into the user input the agent will receive. Defaults
   * to `task.description ?? ''`. Override when subagents expect structured
   * input (e.g. JSON contracts, role-prefixed prompts).
   */
  formatTaskInput?: (task: TaskSpec, config: SubagentConfig) => AgentInput;
  /**
   * When set, the runner attaches the subagent's EventBus to this FleetBus
   * on task start and detaches it when the task finishes. This is the
   * injection seam that lets the TUI fleet panel observe subagent activity
   * live — without it, FleetBus stays empty.
   */
  fleetBus?: FleetBus;
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
    const factoryResult = await opts.factory(ctx.config);
    const { agent, events } = factoryResult;

    // Attach subagent EventBus to FleetBus so the TUI fleet panel (and any
    // other FleetBus subscriber) can observe this subagent live. Detach on
    // task finish — each task is a fresh Agent + EventBus, so we never
    // want a stale bus lingering after the run.
    const detachFleet = opts.fleetBus?.attach(ctx.subagentId, events, task.id);

    // Hook budget into the agent's event stream. We capture errors thrown by
    // recordToolCall/recordUsage so the budget can short-circuit the run by
    // aborting the controller — the agent then unwinds cooperatively.
    const aborter = new AbortController();
    // Inject the EventBus into the budget so it can emit budget.threshold_reached
    // events when a soft limit is hit and the handler wants to ask the coordinator.
    ctx.budget._events = events;
    let budgetError: BudgetExceededError | null = null;

    /**
     * Common error handler for all budget-triggered events. Distinguishes:
     *   - BudgetExceededError → hard stop, set budgetError + abort
     *   - BudgetThresholdSignal → soft stop: await the coordinator's
     *     decision. If 'stop', abort. If 'extend', the signal handler
     *     has already patched the budget so we can continue without
     *     actually aborting the agent.
     */
    const onBudgetError = (err: unknown): void => {
      if (err instanceof BudgetThresholdSignal) {
        // Await the coordinator's verdict before deciding whether to abort.
        err.decision
          .then((decision) => {
            if (decision === 'stop') {
              budgetError = new BudgetExceededError(err.kind, err.limit, err.used);
              aborter.abort();
            }
            // If 'extend': the budget limits were already patched by the
            // BudgetThresholdSignal handler (checkLimit → onThreshold →
            // coordinator extend → budget patched). Do NOT abort.
            // The tool call that triggered the signal will be retried.
          })
          .catch(() => {
            // If the decision promise rejects, treat as hard stop.
            budgetError = new BudgetExceededError(err.kind, err.limit, err.used);
            aborter.abort();
          });
        return;
      }
      // Hard stop (BudgetExceededError or other)
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

    // Track the name of the most recent tool that returned ok:false so
    // we can lift it into the SubagentError when the agent ends without
    // recovering. Cleared on every successful tool execution so a tool
    // that later succeeded doesn't taint the final report.
    let lastToolFailed: string | null = null;

    const unsub: Array<() => void> = [];
    unsub.push(
      events.on('tool.executed', (e) => {
        // Count tool calls on the PAIRED 'tool.executed' event rather
        // than 'tool.started'. A tool can fire start then crash before
        // emitting executed (process killed, signal aborted mid-exec);
        // counting only the paired event keeps the budget tally honest
        // and matches what the model actually saw in its turn.
        try {
          ctx.budget.recordToolCall();
        } catch (eb) {
          onBudgetError(eb);
        }
        // Track ok:false so we can fail the subagent if it ends without
        // recovering. Successful runs clear it — the model may try a
        // tool, get an error, and self-heal on the next iteration; that
        // path should still report success.
        if (e.ok === false) {
          lastToolFailed = e.name;
        } else if (e.ok === true) {
          lastToolFailed = null;
        }
      }),
      events.on('provider.response', (e) => {
        try {
          ctx.budget.recordUsage(e.usage);
        } catch (e2) {
          void onBudgetError(e2);
        }
      }),
      events.on('iteration.started', () => {
        try {
          ctx.budget.recordIteration();
          ctx.budget.checkTimeout();
        } catch (e) {
          void onBudgetError(e);
        }
      }),
      // D3: cooperative timeout enforcement DURING a long tool call.
      // The iteration-loop checkTimeout() only fires between agent
      // iterations — a single `bash sleep 3600` call would otherwise
      // park inside one tool execution while the timeout silently
      // passes, relying solely on the coordinator's hard Promise.race
      // to interrupt. Tools that emit `tool.progress` (bash chunks,
      // fetch byte progress, spawn-stream stdout) give us a heartbeat
      // we can hang the check on. When the budget trips here:
      //   1. onBudgetError sets budgetError + aborter.abort()
      //   2. aborter signal propagates to agent.run → tool executor
      //   3. tool's own signal listener kills the child process
      // Cheap: O(1) per progress event, and the budget short-circuits
      // when timeoutMs is unset (most subagents have one set anyway).
      events.on('tool.progress', () => {
        try {
          ctx.budget.checkTimeout();
        } catch (e) {
          void onBudgetError(e);
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
      detachFleet?.();
      ctx.signal.removeEventListener('abort', onParentAbort);
      for (const u of unsub) u();
      // Per-task resource cleanup. Closes JSONL writers, throwaway
      // providers, etc. that the factory wired up. Swallowed errors —
      // a flaky cleanup must not mask the real task result. The
      // caller can re-emit via observability if needed.
      if (factoryResult.dispose) {
        try {
          await factoryResult.dispose();
        } catch {
          // intentional swallow — see comment above
        }
      }
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
    // Empty-response guard. A "successful" run with no text AND no tool
    // calls is almost always a prompt / config issue, not a real
    // success — the agent burned an iteration to say nothing. Surface
    // it as a classified failure so callers can show "✗ empty_response"
    // instead of a confusing green ✓ with no output. We only trip on
    // the (no-text AND no-tools) intersection because text-less runs
    // with tool calls are legit (e.g. "run npm test then end_turn").
    const finalText = (result.finalText ?? '').trim();
    if (finalText.length === 0 && usage.toolCalls === 0) {
      throw new Error('empty response');
    }
    // Unrecovered-tool-failure guard. If the last executed tool came
    // back ok:false AND the agent ended its turn with no closing text,
    // the agent never acknowledged or recovered from the failure — the
    // task is effectively broken. A model that handles a tool error
    // emits SOME text on the next iteration ("the read failed, trying
    // an alternate path…") which clears `lastToolFailed`; the only way
    // both signals can be live at end-of-run is if the model gave up
    // silently. Surface as `tool_failed` so callers see the actual
    // failure mode instead of a clean ✓ with no output.
    if (finalText.length === 0 && lastToolFailed !== null) {
      throw new Error(`tool failed: ${lastToolFailed}`);
    }
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
