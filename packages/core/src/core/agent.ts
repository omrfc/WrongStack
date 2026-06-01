import { ExtensionRegistry } from '../extension/registry.js';
import type { Container } from '../kernel/container.js';
import type { EventBus } from '../kernel/events.js';
import { Pipeline } from '../kernel/pipeline.js';
import { RunController } from '../kernel/run-controller.js';
import { TOKENS } from '../kernel/tokens.js';
import { estimateRequestTokens } from '../utils/token-estimate.js';
import type { ProviderRegistry } from '../registry/provider-registry.js';
import type { ToolRegistry } from '../registry/tool-registry.js';
import type { ContentBlock, TextBlock, ToolResultBlock, ToolUseBlock } from '../types/blocks.js';
import { isTextBlock, isToolUseBlock } from '../types/blocks.js';
import type { ErrorHandler } from '../types/error-handler.js';
import { AgentError, type WrongStackError, toWrongStackError } from '../types/errors.js';
import type { Logger } from '../types/logger.js';
import type { Tracer } from '../types/observability.js';
import type { PermissionPolicy } from '../types/permission.js';
import type { Plugin, PluginAPI } from '../types/plugin.js';
import type { Request, Response } from '../types/provider.js';
import type { Renderer } from '../types/renderer.js';
import type { RetryPolicy } from '../types/retry-policy.js';
import type { Tool } from '../types/tool.js';
import type { ToolExecutorLike } from '../types/tool-executor.js';
import { repairToolUseAdjacency } from '../utils/message-invariants.js';
import { buildBtwBlock, consumeBtwNotes } from './btw.js';
import { consumeAutonomousContinue, parseContinueDirective, type ContinueDirective } from './continue-to-next-iteration.js';
import type { Context, RunOptions } from './context.js';
import { requestLimitExtension } from './iteration-limit.js';
import { runProviderWithRetry } from './provider-runner.js';

/** Default iteration cap. Use 0 or Infinity via config to disable. */
export const DEFAULT_MAX_ITERATIONS = 100;

export interface RunResult {
  status: 'done' | 'failed' | 'max_iterations' | 'aborted';
  /**
   * Set when `status === 'failed'` (always) or `'aborted'` (when the abort
   * carried an error context). Always a `WrongStackError` so callers can
   * branch on `code`, `severity`, and `recoverable` without parsing strings.
   * Raw throws are wrapped into an `AgentError` with code `AGENT_RUN_FAILED`
   * by `Agent.run` before they reach this field.
   */
  error?: WrongStackError;
  finalText?: string;
  iterations: number;
  /**
   * Subagent delegate summaries collected during the run. Populated by the
   * `delegate` tool — each entry is the `summary` + `ok` fields returned
   * when a subagent finishes. Callers (e.g. TUI/CLI renderer) use this to
   * surface flashy completion banners in the terminal.
   */
  delegateSummaries?: Array<{ summary: string; ok: boolean }>;
}

export interface AgentInit {
  container: Container;
  tools: ToolRegistry;
  providers: ProviderRegistry;
  events: EventBus;
  pipelines: AgentPipelines;
  context: Context;
  maxIterations?: number;
  iterationTimeoutMs?: number;
  executionStrategy?: 'parallel' | 'sequential' | 'smart';
  perIterationOutputCapBytes?: number;
  /**
   * When true (default), the agent automatically extends its iteration
   * limit by 100 when hit, without asking the user. Set to false to
   * emit `iteration.limit_reached` and wait for a listener to grant/deny.
   */
  autoExtendLimit?: boolean;
  /**
   * When true, the agent supports autonomous continuation — the model
   * can signal "keep going" either via the `continue_to_next_iteration()`
   * tool or by placing a `[continue]` / `[next step]` / `[proceed]` /
   * `[done]` marker on its own line in the final text output. The agent
   * loop re-runs without returning to the caller when `continue` is
   * signalled, or exits with `status: 'done'` when `stop` is signalled.
   *
   * The text-marker parser runs in `processResponse()` before the
   * loop-exit check so markers in the final text block are honoured
   * even when no tool was called.
   */
  autonomousContinue?: boolean;
  /**
   * Optional confirm handler. When set, the executor calls it synchronously
   * when a tool needs user confirmation (CLI path). When omitted, the
   * executor returns a `ToolConfirmPendingResult` and the agent emits
   * `tool.confirm_needed` for the TUI to resolve.
   */
  confirmAwaiter?: import('../types/tool-executor.js').ConfirmAwaiter | undefined;
  /**
   * Override the PermissionPolicy resolved from the container. Subagents
   * use this to force auto-approval — they cannot respond to interactive
   * permission prompts, so inheriting the leader's non-YOLO policy would
   * silently hang the entire delegated run on the first tool call.
   */
  permissionPolicy?: PermissionPolicy;
  /**
   * Optional tracer. When provided, `Agent.run` opens an `agent.run` span,
   * per-iteration `agent.iteration` spans, and `provider.complete` spans
   * inside the retry loop. Tool spans are opened by the ToolExecutor.
   * Default is `NoopTracer` (zero overhead).
   */
  tracer?: Tracer | undefined;
  /**
   * Optional extension registry. Plugins and host applications register
   * extensions here to hook into the agent lifecycle (beforeRun, afterRun,
   * beforeIteration, onError, wrapProviderRunner, etc.).
   * When not provided, the agent creates an empty registry internally —
   * no overhead, zero breakage.
   */
  extensions?: ExtensionRegistry | undefined;
  /**
   * Mandatory tool executor. Callers (e.g. CLI wiring) inject a pre-built
   * instance so `core/` does not need a runtime import of `execution/`.
   */
  toolExecutor: ToolExecutorLike;
}

export interface AgentPipelines {
  request: Pipeline<Request>;
  response: Pipeline<Response>;
  toolCall: Pipeline<ToolCallPipelinePayload>;
  userInput: Pipeline<UserInputPayload>;
  assistantOutput: Pipeline<TextBlock>;
  contextWindow: Pipeline<Context>;
}

export interface UserInputPayload {
  content: ContentBlock[];
  /** Concatenation of text blocks — convenience for middleware that only cares about text. */
  text: string;
  ctx: Context;
}

export type AgentInput = string | ContentBlock[];

function normalizeInput(input: AgentInput): { blocks: ContentBlock[]; text: string } {
  if (typeof input === 'string') {
    return { blocks: [{ type: 'text', text: input }], text: input };
  }
  const text = input
    .filter(isTextBlock)
    .map((b) => b.text)
    .join('');
  return { blocks: input, text };
}

export interface ToolCallPipelinePayload {
  toolUse: ToolUseBlock;
  result: ToolResultBlock;
  ctx: Context;
  /** Undefined when the model invoked a tool name we don't know. */
  tool?: Tool;
}

export function createDefaultPipelines(): AgentPipelines {
  return {
    request: new Pipeline<Request>(),
    response: new Pipeline<Response>(),
    toolCall: new Pipeline<ToolCallPipelinePayload>(),
    userInput: new Pipeline<UserInputPayload>(),
    assistantOutput: new Pipeline<TextBlock>(),
    contextWindow: new Pipeline<Context>(),
  };
}

export class Agent {
  readonly container: Container;
  readonly tools: ToolRegistry;
  readonly providers: ProviderRegistry;
  readonly events: EventBus;
  readonly pipelines: AgentPipelines;
  readonly ctx: Context;
  private readonly maxIterations: number;
  private readonly executionStrategy: 'parallel' | 'sequential' | 'smart';
  private readonly perIterationOutputCapBytes: number;
  private readonly plugins: { plugin: Plugin; api: PluginAPI }[] = [];
  private readonly toolExecutor: ToolExecutorLike;
  private readonly autoExtendLimit: boolean;
  /** Enables autonomous continue: model can signal `[continue]` or call continue_to_next_iteration() to re-run. */
  private readonly autonomousContinue: boolean;
  private readonly tracer: Tracer | undefined;
  readonly extensions: ExtensionRegistry;

  constructor(init: AgentInit) {
    this.container = init.container;
    this.tools = init.tools;
    this.providers = init.providers;
    this.events = init.events;
    this.pipelines = init.pipelines;
    this.ctx = init.context;
    this.maxIterations = init.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.executionStrategy = init.executionStrategy ?? 'smart';
    this.perIterationOutputCapBytes = init.perIterationOutputCapBytes ?? 100_000;
    this.autoExtendLimit = init.autoExtendLimit ?? true;
    this.autonomousContinue = init.autonomousContinue ?? false;
    this.tracer = init.tracer;
    this.extensions = init.extensions ?? new ExtensionRegistry();
    this.extensions.setLogger(this.container.resolve(TOKENS.Logger));
    this.toolExecutor = init.toolExecutor;
  }

  private get logger(): Logger {
    return this.container.resolve(TOKENS.Logger);
  }
  private get retry(): RetryPolicy {
    return this.container.resolve(TOKENS.RetryPolicy);
  }
  private get errorHandler(): ErrorHandler {
    return this.container.resolve(TOKENS.ErrorHandler);
  }
  private get permission(): PermissionPolicy {
    return this.container.resolve(TOKENS.PermissionPolicy);
  }
  private get renderer(): Renderer | undefined {
    return this.container.has(TOKENS.Renderer)
      ? this.container.resolve(TOKENS.Renderer)
      : undefined;
  }

  /**
   * Switch from inline CLI prompts to event-driven confirmation.
   * Clears both the ToolExecutor's confirmAwaiter (so it returns
   * `ToolConfirmPendingResult`) and the permission policy's
   * promptDelegate (so `evaluate()` returns `confirm`).
   *
   * Call this before entering TUI or any mode where stdin is owned
   * by a UI framework (Ink, WebUI WS bridge). Without this, the
   * inline prompt writes to stdout and blocks on stdin — both of
   * which are owned by the framework — making the prompt invisible
   * and the input deadlocked.
   */
  disableInteractiveConfirmation(): void {
    this.toolExecutor.clearConfirmAwaiter();
    const policy = this.permission as unknown as { setPromptDelegate?: (d: undefined) => void };
    if (typeof policy.setPromptDelegate === 'function') {
      policy.setPromptDelegate(undefined);
    }
  }

  register(tool: Tool): void {
    this.tools.register(tool);
  }

  async use(plugin: Plugin, api: PluginAPI): Promise<void> {
    await plugin.setup(api);
    this.plugins.push({ plugin, api });
  }

  /** Tear down all plugins in reverse order, calling their teardown hooks. */
  async teardown(): Promise<void> {
    const errors: unknown[] = [];
    for (const { plugin, api } of this.plugins.toReversed()) {
      if (typeof plugin.teardown !== 'function') continue;
      try {
        await plugin.teardown(api);
      } catch (err) {
        errors.push(err);
      }
    }
    this.plugins.length = 0;
    if (errors.length > 0) {
      throw new Error(`Agent teardown failed: ${errors.map(String).join('; ')}`);
    }
  }

  async run(userInput: AgentInput, opts: RunOptions = {}): Promise<RunResult> {
    const controller = new RunController({ parentSignal: opts.signal });
    const signal = controller.signal;
    this.ctx.signal = signal;
    // Flush abort hooks registered on the context when this run ends or
    // is aborted. Tools / MCP / file handles register via ctx.registerAbortHook.
    controller.onAbort(() => this.ctx.drainAbortHooks());

    const span = this.tracer?.startSpan('agent.run', {
      'agent.model': opts.model ?? this.ctx.model,
      'agent.executionStrategy': opts.executionStrategy ?? this.executionStrategy,
    });

    // Normalize input once so beforeRun hooks see the canonical payload
    const { blocks, text } = normalizeInput(userInput);
    const inputPayload = { content: blocks, text, ctx: this.ctx };

    // Extension: beforeRun hooks — a thrown error is caught and logged;
    // the run proceeds. This matches the Pipeline error-boundary philosophy:
    // one bad listener can't kill the agent.
    await this.extensions.runBeforeRun(this.ctx, inputPayload);

    try {
      const result = await this.runInner(inputPayload, opts, controller);
      span?.setAttribute('agent.status', result.status);
      span?.setAttribute('agent.iterations', result.iterations);

      // Extension: afterRun — always called, even on failed/aborted runs.
      await this.extensions.runAfterRun(this.ctx, result);

      return result;
    } catch (err) {
      // Any throw that escapes runInner is treated as a hard agent failure.
      // Wrap into a WrongStackError so callers always see a structured error
      // and never have to unwrap `unknown` in user-facing paths.
      const wse = err instanceof AgentError ? err : toWrongStackError(err);
      this.events.emit('error', { err: toError(err), phase: 'agent' });
      if (err instanceof Error) span?.recordError(err);
      span?.setAttribute('agent.status', 'failed');
      const result: RunResult = {
        status: signal.aborted ? 'aborted' : 'failed',
        iterations: 0,
        error: wse,
      };
      // Extension: afterRun on hard failure too
      await this.extensions.runAfterRun(this.ctx, result);
      return result;
    } finally {
      span?.end();
      await controller.dispose();
    }
  }

  private async runInner(
    inputPayload: UserInputPayload,
    opts: RunOptions,
    controller: RunController,
  ): Promise<RunResult> {
    // Emit user input through pipeline and append to session (already normalized in run())
    await this.pipelines.userInput.run(inputPayload);
    this.ctx.state.appendMessage({ role: 'user', content: inputPayload.content });
    await this.ctx.session.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: inputPayload.content,
    });

    // Write checkpoint after user input is recorded — this marks the rewind
    // point for this turn. promptIndex is 0-based (Nth user message).
    const promptIndex = this.ctx.messages.filter((m) => m.role === 'user').length - 1;
    const preview = inputPayload.text.slice(0, 80) + (inputPayload.text.length > 80 ? '…' : '');
    await this.ctx.session.writeCheckpoint(promptIndex, preview);

    let finalText = '';
    let iterations = 0;
    const delegateSummaries: Array<{ summary: string; ok: boolean }> = [];
    let effectiveLimit = opts.maxIterations ?? this.maxIterations;
    const hasHardLimit = effectiveLimit > 0 && Number.isFinite(effectiveLimit);
    let recoveryRetries = 0;
    // Per-run autonomous continue. Documented on RunOptions but historically
    // ignored — the loop only read `this.autonomousContinue`. Now an explicit
    // `opts.autonomousContinue` overrides the instance default so the same
    // Agent can flip into autonomous mode for a single eternal-engine
    // iteration without a constructor rebuild.
    const autonomousContinue = opts.autonomousContinue ?? this.autonomousContinue;

    // Collect subagent done summaries for RunResult.delegateSummaries.
    const onSubagentDone = ({ summary, ok }: { summary: string; ok: boolean }) => {
      delegateSummaries.push({ summary, ok });
    };
    const offSubagentDone = this.events.on('subagent.done', onSubagentDone);

    // Build the base provider runner: resolve from DI if bound, otherwise
    // use the built-in runProviderWithRetry (backward compat — consumers
    // that don't bind TOKENS.ProviderRunner get the default behavior).
    const diRunner = this.container.has(TOKENS.ProviderRunner)
      ? this.container.resolve(TOKENS.ProviderRunner)
      : null;

    const baseRunner = diRunner
      ? (ctx: import('./context.js').Context, req: import('../types/provider.js').Request) =>
          diRunner.run({
            provider: ctx.provider,
            request: req,
            signal: controller.signal,
            ctx,
            events: this.events,
            retry: this.retry,
            logger: this.logger,
            tracer: this.tracer,
          })
      : async (ctx: import('./context.js').Context, req: import('../types/provider.js').Request) =>
          runProviderWithRetry({
            provider: ctx.provider,
            request: req,
            signal: controller.signal,
            ctx,
            events: this.events,
            retry: this.retry,
            logger: this.logger,
            tracer: this.tracer,
          });

    // Build composed provider runner (extensions wrap the base runner)
    const customRunner = this.extensions.wrapProviderRunner(baseRunner);

    try {
      for (let i = 0; ; i++) {
        iterations = i + 1;
        if (controller.signal.aborted) {
          return { status: 'aborted', iterations };
        }

        // Idea #1 — Stateful Session Recovery. Mark the start of
        // each iteration so a crashed process leaves a visible
        // "iteration N was in flight when the process died" record.
        // The matching `clearInFlightMarker` runs after the iteration
        // completes (success or thrown). Pairs with SessionRecovery
        // and `/resume --incomplete`.
        await this.ctx.session
          .writeInFlightMarker(`iteration ${i} / max ${this.maxIterations}`)
          .catch((err) => {
            // Marker writes are best-effort — never let a logging
            // failure abort the agent loop.
            this.logger.debug?.(
              `in-flight marker write failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });

        // Clear any stale autonomous continue flag from a prior iteration.
        // This prevents a stale flag (e.g. from a tool call that set it but
        // then the run crashed before the flag was consumed) from causing
        // a spurious continuation on the next agent.run() call.
        if (autonomousContinue) {
          consumeAutonomousContinue(this.ctx);
        }

        const limitCheck = await this.checkIterationLimit(
          i,
          effectiveLimit,
          hasHardLimit,
          iterations,
          delegateSummaries,
        );
        effectiveLimit = limitCheck.limit;
        if (limitCheck.exit) {
          return { ...limitCheck.exit, finalText };
        }

        // Extension: beforeIteration
        await this.extensions.runBeforeIteration(this.ctx, i);

        this.events.emit('iteration.started', { ctx: this.ctx, index: i });

        // Drain any `/btw` notes the user stashed mid-run and fold them into
        // the conversation before this iteration's request is built.
        this.injectPendingBtwNotes();

        const req = await this.buildAndRunRequestPipeline(opts);

        let res: Response;
        try {
          res = await customRunner(this.ctx, req);
          recoveryRetries = 0;
        } catch (err) {
          if (controller.signal.aborted) {
            this.events.emit('error', { err: toError(err), phase: 'provider' });
            return { status: 'aborted', iterations, error: toWrongStackError(err, 'AGENT_ABORTED') };
          }

          // Extension: onError — extensions get first crack at recovery
          const extDecision = await this.extensions.runOnError(this.ctx, err, 'provider', i);
          if (extDecision) {
            if (extDecision.action === 'fail') {
              this.events.emit('error', { err: toError(err), phase: 'provider' });
              return { status: 'failed', iterations, error: toWrongStackError(err), delegateSummaries };
            }
            if (extDecision.action === 'continue') {
              // Extension says skip this turn — go to next iteration
              await this.extensions.runAfterIteration(this.ctx, i);
              continue;
            }
            if (extDecision.action === 'retry') {
              recoveryRetries++;
              if (recoveryRetries > 2) {
                this.events.emit('error', { err: toError(err), phase: 'provider' });
                return { status: 'failed', iterations, error: toWrongStackError(err), delegateSummaries };
              }
              if (extDecision.model) this.ctx.model = extDecision.model;
              this.logger.info('Extension requested retry; retrying turn');
              continue;
            }
          }

          const recovered = await this.errorHandler.recover(err, this.ctx);
          if (!recovered || recovered.action === 'fail') {
            this.events.emit('error', { err: toError(err), phase: 'provider' });
            return {
              status: 'failed',
              iterations,
              error: toWrongStackError(recovered?.error ?? err),
              delegateSummaries,
            };
          }
          if (recovered.action === 'retry') {
            recoveryRetries++;
            if (recoveryRetries > 2) {
              this.events.emit('error', { err: toError(err), phase: 'provider' });
              return { status: 'failed', iterations, error: toWrongStackError(err) };
            }
            if (recovered.model) this.ctx.model = recovered.model;
            this.logger.info(`Recovered provider error via ${recovered.reason}; retrying turn`);
            continue;
          }
          recoveryRetries = 0;
          res = recovered.response;
        }

        const responseResult = await this.processResponse(res, req);
        if (responseResult.aborted) {
          return { status: 'aborted', iterations, finalText: responseResult.finalText, delegateSummaries };
        }
        if (responseResult.done) {
          return { status: 'done', iterations, finalText: responseResult.finalText, delegateSummaries };
        }

        finalText = responseResult.finalText;

        const toolUses = res.content.filter(isToolUseBlock);
        if (toolUses.length === 0) {
          // No tool calls — check autonomous continue text marker before exiting.
          // The model can signal [continue] to re-run even without a tool call.
          this.emitContextPct();
          this.events.emit('iteration.completed', { ctx: this.ctx, index: i });
          if (autonomousContinue && responseResult.directive === 'continue') {
            await this.compactContextIfNeeded();
            await this.extensions.runAfterIteration(this.ctx, i);
            continue;
          }
          if (autonomousContinue && responseResult.directive === 'stop') {
            return { status: 'done', iterations, finalText, delegateSummaries };
          }
          return { status: 'done', iterations, finalText, delegateSummaries };
        }

        await this.executeTools(toolUses);

        // Autonomous continue via tool flag: if the model called
        // `continue_to_next_iteration()` the flag is set; consume it and
        // re-run the loop immediately without returning to the caller.
        // This allows fully autonomous operation where the model keeps
        // working across multiple turns without the outer runner having
        // to re-invoke Agent.run().
        if (autonomousContinue && consumeAutonomousContinue(this.ctx)) {
          this.emitContextPct();
          this.events.emit('iteration.completed', { ctx: this.ctx, index: i });
          await this.compactContextIfNeeded();
          await this.extensions.runAfterIteration(this.ctx, i);
          continue;
        }

        this.emitContextPct();
        this.events.emit('iteration.completed', { ctx: this.ctx, index: i });

        await this.compactContextIfNeeded();

        // Extension: afterIteration
        await this.extensions.runAfterIteration(this.ctx, i);

        // Autonomous continue via text marker: if `processResponse` detected
        // a `[continue]` / `[next step]` marker, re-run the loop without
        // returning to the caller. `[done]` causes an immediate exit with 'done'.
        if (autonomousContinue && responseResult.directive === 'continue') {
          continue;
        }
        if (autonomousContinue && responseResult.directive === 'stop') {
          return { status: 'done', iterations, finalText, delegateSummaries };
        }
      }
    } finally {
      offSubagentDone();
      // Idea #1 — close the in-flight marker on every exit path. The
      // controller.signal check at the loop top will have set
      // `aborted` first, so this distinguishes "user asked to stop"
      // from "ran to completion". The `clean` / `aborted` split is
      // what `SessionRecovery.detectStale` and postmortem tooling
      // look at to decide whether a session is resumable.
      const reason: 'clean' | 'aborted' = controller.signal.aborted ? 'aborted' : 'clean';
      await this.ctx.session
        .clearInFlightMarker(reason)
        .catch((err) => {
          this.logger.debug?.(
            `in-flight marker clear failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
    }
  }

  /**
   * Check if iteration limit has been reached and request extension if needed.
   * Returns the new effective limit (possibly extended) and a RunResult if
   * the loop should exit. Returns `{ limit }` with no result when the
   * iteration may proceed.
   */
  private async checkIterationLimit(
    iterationIndex: number,
    limit: number,
    hasHardLimit: boolean,
    currentIterations: number,
    delegateSummaries: Array<{ summary: string; ok: boolean }>,
  ): Promise<{ limit: number; exit?: RunResult }> {
    if (hasHardLimit && iterationIndex >= limit) {
      const extendBy = await requestLimitExtension({
        events: this.events,
        currentIterations,
        currentLimit: limit,
        autoExtend: this.autoExtendLimit,
      });
      if (extendBy > 0) {
        const newLimit = limit + extendBy;
        this.logger.info(`Iteration limit extended by ${extendBy} (new limit: ${newLimit})`);
        return { limit: newLimit };
      }
      return { limit, exit: { status: 'max_iterations', iterations: currentIterations, delegateSummaries } };
    }
    return { limit };
  }

  /**
   * Build request and run through request pipeline.
   */
  private async buildAndRunRequestPipeline(opts: RunOptions): Promise<Request> {
    const repaired = repairToolUseAdjacency(this.ctx.messages);
    if (repaired.report.changed) {
      this.ctx.state.replaceMessages(repaired.messages);
      this.events.emit('context.repaired', {
        ctx: this.ctx,
        ...repaired.report,
      });
      this.logger.warn(
        `Repaired context tool adjacency: removed ${repaired.report.removedToolUses.length} tool_use block(s), ` +
          `${repaired.report.removedToolResults.length} tool_result block(s), ` +
          `${repaired.report.removedMessages} empty message(s)`,
      );
    }
    const baseReq: Request = {
      model: opts.model ?? this.ctx.model,
      system: this.ctx.systemPrompt,
      messages: this.ctx.messages,
      tools: this.tools.list(),
      maxTokens: 8192,
    };
    return this.pipelines.request.run(baseReq);
  }

  /**
   * Process the provider response: run response pipeline, emit events,
   * update session, render text, handle abort.
   */
  private async processResponse(
    raw: Response,
    req: Request,
  ): Promise<{ finalText: string; aborted: boolean; done: boolean; directive?: ContinueDirective }> {
    // Run response middleware and adopt any transform it returns so later code
    // sees the processed value (currently no middleware is registered, but the
    // pattern matches `assistantOutput` below).
    let res = raw;
    res = await this.pipelines.response.run(res);
    this.events.emit('provider.response', {
      ctx: this.ctx,
      usage: res.usage,
      stopReason: res.stopReason,
    });
    this.ctx.tokenCounter.account(res.usage, req.model);

    // Persist the partial assistant message even when the run was
    // aborted mid-stream — having the partial text in `ctx.messages`
    // means the next turn can continue with full context and the
    // session log is consistent.
    this.ctx.state.appendMessage({ role: 'assistant', content: res.content });
    await this.ctx.session.append({
      type: 'llm_response',
      ts: new Date().toISOString(),
      content: res.content,
      stopReason: res.stopReason,
      usage: res.usage,
    });

    if (this.ctx.signal.aborted) {
      // Accumulate any text the user did see so callers can show "you
      // got this much before cancelling" if they want.
      let finalText = '';
      for (const block of res.content) {
        if (isTextBlock(block)) finalText += block.text;
      }
      return { finalText, aborted: true, done: false };
    }

    // Render text blocks. For streaming providers the renderer already
    // saw the text via provider.text_delta events; we still run the
    // assistantOutput pipeline (for transforms) and accumulate finalText,
    // but we don't double-write to the renderer.
    let finalText = '';
    const streamed = this.ctx.provider.capabilities.streaming;
    for (const block of res.content) {
      if (isTextBlock(block)) {
        const rendered = await this.pipelines.assistantOutput.run(block);
        finalText += rendered.text;
        if (!streamed) this.renderer?.write(rendered);
      }
    }

    // Autonomous continuation: check for text markers unconditionally.
    // The parser is cheap (single regex pass) and the caller (`runInner`)
    // decides whether to honour the directive based on the per-run
    // `autonomousContinue` flag — keeping the parse here means a per-call
    // `opts.autonomousContinue: true` works even when the Agent instance
    // was constructed with the default `false`.
    let directive: ContinueDirective = 'none';
    if (finalText) {
      directive = parseContinueDirective(finalText);
    }

    return { finalText, aborted: false, done: false, directive };
  }

  /**
   * Execute tools and append tool results to context.
   * When a tool returns `tool_confirm_pending` (no confirmAwaiter set),
   * we pause and emit `tool.confirm_needed`. The run is blocked until
   * the event listener resolves the confirmation, then we re-run the
   * single tool.
   */
  private async executeTools(toolUses: ToolUseBlock[]): Promise<void> {
    // Extension: beforeToolExecution — allow filtering/reordering tools
    const selectedToolUses = await this.extensions.runBeforeToolExecution(this.ctx, toolUses);

    const { outputs } = await this.toolExecutor.executeBatch(
      selectedToolUses,
      this.ctx,
      this.executionStrategy,
    );

    // Post-processing: pipeline, session, events
    const useById = new Map(selectedToolUses.map((u) => [u.id, u]));
    for (const { result, tool, durationMs } of outputs) {
      // Handle pending confirm: block the agent loop and wait for TUI/WebUI resolution
      if (result.type === 'tool_confirm_pending') {
        const decision = await this.waitForConfirm({
          tool: tool!,
          input: result.input,
          toolUseId: result.toolUseId,
          suggestedPattern: result.suggestedPattern,
        });
        // Persist trust/deny rule when user picks 'always' or 'deny' — mirrors the
        // promptDelegate path in DefaultPermissionPolicy.evaluate() so
        // event-driven confirmation (TUI/WebUI) gets the same trust-file
        // persistence as the CLI's inline prompt.
        if (decision === 'always') {
          try {
            await this.permission.trust({
              tool: tool!.name,
              pattern: result.suggestedPattern,
            });
            this.events.emit('trust.persisted', {
              tool: tool!.name,
              pattern: result.suggestedPattern,
              decision,
            });
          } catch {
            // best-effort — trust persistence failure shouldn't block execution
          }
        } else if (decision === 'deny') {
          try {
            await this.permission.deny({
              tool: tool!.name,
              pattern: result.suggestedPattern,
            });
            this.events.emit('trust.persisted', {
              tool: tool!.name,
              pattern: result.suggestedPattern,
              decision,
            });
          } catch {
            // best-effort — deny persistence failure shouldn't block execution
          }
        }

        // Re-run the tool with the resolved decision.
        // Semantics:
        //   'yes'     → execute tool once, no persistence (but soft-allow for retry)
        //   'always'  → execute tool + persist allow rule (future calls auto-approved)
        //   'no'      → return error, no persistence (but soft-deny for retry)
        //   'deny'    → return error + persist deny rule (future calls auto-denied)
        if (decision === 'yes') {
          // Soft allow: prevent confirm prompt on LLM retry within this session
          const p = this.permission as unknown as { allowOnce?(r: { tool: string; pattern: string }): void };
          p.allowOnce?.({ tool: tool!.name, pattern: result.suggestedPattern });
        } else if (decision === 'no') {
          // Soft deny: prevent confirm prompt on LLM retry within this session
          const p = this.permission as unknown as { denyOnce?(r: { tool: string; pattern: string }): void };
          p.denyOnce?.({ tool: tool!.name, pattern: result.suggestedPattern });
        }
        const reRunResult =
          decision === 'yes' || decision === 'always'
            ? await this.executeSingleWithDecision(
                tool!,
                { id: result.toolUseId, name: tool!.name, input: result.input },
              )
            : {
                result: {
                  type: 'tool_result' as const,
                  tool_use_id: result.toolUseId,
                  content:
                    decision === 'deny'
                      ? `Tool "${tool!.name}" denied and blocked for this pattern.`
                      : `Tool "${tool!.name}" denied by user.`,
                  is_error: true,
                },
                durationMs: 0,
              };
        const use = useById.get(reRunResult.result.tool_use_id);
        if (use) {
          await this.pipelines.toolCall.run({
            toolUse: use,
            result: reRunResult.result,
            ctx: this.ctx,
            tool,
          });
          await this.ctx.session.append({
            type: 'tool_result',
            ts: new Date().toISOString(),
            id: reRunResult.result.tool_use_id,
            content: reRunResult.result.content,
            isError: !!reRunResult.result.is_error,
          });
          {
            const sig = sizeSignals(tool?.name, reRunResult.result.content);
            this.events.emit('tool.executed', {
              id: reRunResult.result.tool_use_id,
              name: tool!.name,
              durationMs: reRunResult.durationMs,
              ok: !reRunResult.result.is_error,
              input: result.input,
              output: truncateForEvent(reRunResult.result.content),
              outputBytes: sig.outputBytes,
              outputTokens: sig.outputTokens,
              outputLines: sig.outputLines,
            });
          }
        }
        // Re-run result already appended above — skip the generic append at loop end.
        continue;
      }

      const use = useById.get(result.tool_use_id);
      if (!use) continue;
      await this.pipelines.toolCall.run({
        toolUse: use,
        result,
        ctx: this.ctx,
        tool: tool ?? undefined,
      });
      await this.ctx.session.append({
        type: 'tool_result',
        ts: new Date().toISOString(),
        id: result.tool_use_id,
        content: result.content,
        isError: !!result.is_error,
      });
      {
        const sig = sizeSignals(use.name, result.content);
        this.events.emit('tool.executed', {
          id: result.tool_use_id,
          name: use.name,
          durationMs,
          ok: !result.is_error,
          input: use.input,
          output: truncateForEvent(result.content),
          outputBytes: sig.outputBytes,
          outputTokens: sig.outputTokens,
          outputLines: sig.outputLines,
        });
      }
    }

    this.ctx.state.appendMessage({
      role: 'user',
      content: outputs.map((o) => o.result) as ToolResultBlock[],
    });

    // Extension: afterToolExecution — inspect or react to tool results
    await this.extensions.runAfterToolExecution(this.ctx, outputs);
  }

  /**
   * Fold any pending `/btw` notes into the conversation. Called at the top of
   * each iteration so a note set mid-run reaches the model on its next turn.
   *
   * To stay valid across all provider wire families we never create two
   * consecutive user messages: if the last message is a user turn (e.g. the
   * tool_result block from the previous iteration) we append the note as an
   * extra text block on that turn; otherwise we add a fresh user message.
   */
  private injectPendingBtwNotes(): void {
    const notes = consumeBtwNotes(this.ctx);
    if (notes.length === 0) return;
    const block: TextBlock = { type: 'text', text: buildBtwBlock(notes) };

    const messages = this.ctx.messages;
    const last = messages[messages.length - 1];
    if (last && last.role === 'user') {
      const content: ContentBlock[] =
        typeof last.content === 'string'
          ? [{ type: 'text', text: last.content }, block]
          : [...last.content, block];
      this.ctx.state.replaceMessages([...messages.slice(0, -1), { ...last, content }]);
    } else {
      this.ctx.state.appendMessage({ role: 'user', content: [block] });
    }
  }

  private waitForConfirm(info: {
    tool: Tool;
    input: unknown;
    toolUseId: string;
    suggestedPattern: string;
  }): Promise<'yes' | 'no' | 'always' | 'deny'> {
    return new Promise((resolve) => {
      this.events.emit('tool.confirm_needed', {
        tool: info.tool,
        input: info.input,
        toolUseId: info.toolUseId,
        suggestedPattern: info.suggestedPattern,
        resolve,
      });
    });
  }

  private async executeSingleWithDecision(
    tool: Tool,
    use: { id: string; name: string; input: unknown },
  ): Promise<{ result: ToolResultBlock; durationMs: number }> {
    const start = Date.now();
    try {
      const result = await this.toolExecutor.executeTool(
        tool,
        use as ToolUseBlock,
        this.ctx,
        this.perIterationOutputCapBytes,
      );
      return { result, durationMs: Date.now() - start };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        result: {
          type: 'tool_result',
          tool_use_id: use.id,
          content: `Tool "${tool.name}" threw: ${msg}`,
          is_error: true,
        },
        durationMs: Date.now() - start,
      };
    }
  }

  /**
   * Run context window pipeline. The pipeline may be empty, or it may contain
   * middleware with its own injected dependencies.
   */
  private async compactContextIfNeeded(): Promise<void> {
    await this.pipelines.contextWindow.run(this.ctx);
  }

  /**
   * Emit the current context window load as a `ctx.pct` event so subscribers
   * (FleetBus → TUI) can render a live fill bar per agent.
   */
  private emitContextPct(): void {
    const maxContext = this.ctx.provider.capabilities.maxContext ?? 200_000;
    const { total } = estimateRequestTokens(
      this.ctx.messages,
      this.ctx.systemPrompt,
      this.ctx.tools ?? [],
    );
    this.events.emit('ctx.pct', { load: total / maxContext, tokens: total, maxContext });
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Render a tool result body for inclusion in the `tool.executed` event.
 * Tool outputs can be large (file dumps, command output); UIs only want a
 * preview line, so cap at ~400 chars with an ellipsis marker. Structured
 * content blocks are flattened to their text portions.
 */
function truncateForEvent(content: ToolResultBlock['content'], max = 400): string {
  if (!content) return '';
  return content.length <= max ? content : `${content.slice(0, max - 1)}…`;
}

/**
 * Derive size signals (bytes / tokens / lines) for the chip rendered beside
 * each tool result. Computed once over the FULL `result.content` BEFORE the
 * 400-char event preview is taken — the whole point is to surface what the
 * model actually paid for, not the teaser.
 *
 *  - bytes: UTF-8 byte length (multi-byte aware — JS string.length would
 *    miscount Turkish/CJK output).
 *  - tokens: standard ~3.5 chars/token heuristic; close enough for an
 *    inline chip, authoritative count still lands via provider.response.
 *  - lines: read prefixes lines with `<n>→`; for shell/grep/logs we fall
 *    back to a newline count. Undefined for tools without a line notion.
 */
function sizeSignals(
  toolName: string | undefined,
  content: ToolResultBlock['content'],
): { outputBytes: number; outputTokens: number; outputLines: number | undefined } {
  if (typeof content !== 'string' || content.length === 0) {
    return { outputBytes: 0, outputTokens: 0, outputLines: undefined };
  }
  const outputBytes = Buffer.byteLength(content, 'utf8');
  const outputTokens = Math.max(1, Math.round(outputBytes / 3.5));
  let outputLines: number | undefined;
  if (toolName === 'read') {
    const lineRe = /^\s*\d+→/gm;
    let count = 0;
    while (lineRe.exec(content) !== null) count++;
    if (count > 0) outputLines = count;
  } else if (
    toolName === 'bash' ||
    toolName === 'shell' ||
    toolName === 'grep' ||
    toolName === 'logs'
  ) {
    let nl = 0;
    for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) nl++;
    outputLines = nl + (content.endsWith('\n') ? 0 : 1);
  }
  return { outputBytes, outputTokens, outputLines };
}
