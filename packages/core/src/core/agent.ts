import { ExtensionRegistry } from '../extension/registry.js';
import { ToolExecutor } from '../execution/tool-executor.js';
import type { Container } from '../kernel/container.js';
import type { EventBus } from '../kernel/events.js';
import { Pipeline } from '../kernel/pipeline.js';
import { RunController } from '../kernel/run-controller.js';
import { TOKENS } from '../kernel/tokens.js';
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
import type { SecretScrubber } from '../types/secret-scrubber.js';
import type { Tool } from '../types/tool.js';
import { repairToolUseAdjacency } from '../utils/message-invariants.js';
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
  private readonly iterationTimeoutMs: number;
  private readonly executionStrategy: 'parallel' | 'sequential' | 'smart';
  private readonly perIterationOutputCapBytes: number;
  private readonly plugins: { plugin: Plugin; api: PluginAPI }[] = [];
  private readonly toolExecutor: ToolExecutor;
  private readonly autoExtendLimit: boolean;
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
    this.iterationTimeoutMs = init.iterationTimeoutMs ?? 300_000;
    this.executionStrategy = init.executionStrategy ?? 'smart';
    this.perIterationOutputCapBytes = init.perIterationOutputCapBytes ?? 100_000;
    this.autoExtendLimit = init.autoExtendLimit ?? true;
    this.tracer = init.tracer;
    this.extensions = init.extensions ?? new ExtensionRegistry();
    this.extensions.setLogger(this.container.resolve(TOKENS.Logger));
    this.toolExecutor = new ToolExecutor(this.tools, {
      permissionPolicy: init.permissionPolicy ?? this.permission,
      secretScrubber: this.scrubber,
      renderer: this.renderer,
      events: this.events,
      confirmAwaiter: init.confirmAwaiter,
      iterationTimeoutMs: this.iterationTimeoutMs,
      perIterationOutputCapBytes: this.perIterationOutputCapBytes,
      tracer: this.tracer,
    });
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
  private get scrubber(): SecretScrubber {
    return this.container.resolve(TOKENS.SecretScrubber);
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

    let finalText = '';
    let iterations = 0;
    let effectiveLimit = opts.maxIterations ?? this.maxIterations;
    const hasHardLimit = effectiveLimit > 0 && Number.isFinite(effectiveLimit);
    let recoveryRetries = 0;

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

    for (let i = 0; ; i++) {
      iterations = i + 1;
      if (controller.signal.aborted) {
        return { status: 'aborted', iterations };
      }

      const limitCheck = await this.checkIterationLimit(
        i,
        effectiveLimit,
        hasHardLimit,
        iterations,
      );
      effectiveLimit = limitCheck.limit;
      if (limitCheck.exit) {
        return { ...limitCheck.exit, finalText };
      }

      // Extension: beforeIteration
      await this.extensions.runBeforeIteration(this.ctx, i);

      this.events.emit('iteration.started', { ctx: this.ctx, index: i });

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
            return { status: 'failed', iterations, error: toWrongStackError(err) };
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
              return { status: 'failed', iterations, error: toWrongStackError(err) };
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
        return { status: 'aborted', iterations, finalText: responseResult.finalText };
      }
      if (responseResult.done) {
        return { status: 'done', iterations, finalText: responseResult.finalText };
      }

      finalText = responseResult.finalText;

      const toolUses = res.content.filter(isToolUseBlock);
      if (toolUses.length === 0) {
        this.events.emit('iteration.completed', { ctx: this.ctx, index: i });
        return { status: 'done', iterations, finalText };
      }

      await this.executeTools(toolUses);
      this.events.emit('iteration.completed', { ctx: this.ctx, index: i });

      await this.compactContextIfNeeded();

      // Extension: afterIteration
      await this.extensions.runAfterIteration(this.ctx, i);
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
      return { limit, exit: { status: 'max_iterations', iterations: currentIterations } };
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
  ): Promise<{ finalText: string; aborted: boolean; done: boolean }> {
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

    return { finalText, aborted: false, done: false };
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
