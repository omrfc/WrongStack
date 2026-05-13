import type { Container } from '../kernel/container.js';
import type { EventBus } from '../kernel/events.js';
import { Pipeline } from '../kernel/pipeline.js';
import { RunController } from '../kernel/run-controller.js';
import { TOKENS } from '../kernel/tokens.js';
import type { Tool } from '../types/tool.js';
import type { ContentBlock, TextBlock, ToolResultBlock, ToolUseBlock } from '../types/blocks.js';
import { isTextBlock, isToolUseBlock } from '../types/blocks.js';
import type { Request, Response, Provider } from '../types/provider.js';
import { ProviderError } from '../types/provider.js';
import type { Logger } from '../types/logger.js';
import type { RetryPolicy } from '../types/retry-policy.js';
import type { ErrorHandler } from '../types/error-handler.js';
import type { Compactor } from '../types/compactor.js';
import type { PermissionPolicy } from '../types/permission.js';
import type { SecretScrubber } from '../types/secret-scrubber.js';
import type { Renderer } from '../types/renderer.js';
import type { Plugin, PluginAPI } from '../types/plugin.js';
import type { Context, RunOptions } from './context.js';
import type { ToolRegistry } from '../registry/tool-registry.js';
import type { ProviderRegistry } from '../registry/provider-registry.js';
import { ToolExecutor } from '../defaults/tool-executor.js';
import { streamProviderToResponse } from './streaming-response-builder.js';

/** Default iteration cap. Use 0 or Infinity via config to disable. */
export const DEFAULT_MAX_ITERATIONS = 100;

export interface RunResult {
  status: 'done' | 'failed' | 'max_iterations' | 'aborted';
  error?: unknown;
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
    this.toolExecutor = new ToolExecutor(this.tools, {
      permissionPolicy: this.permission,
      secretScrubber: this.scrubber,
      renderer: this.renderer,
      events: this.events,
      iterationTimeoutMs: this.iterationTimeoutMs,
      perIterationOutputCapBytes: this.perIterationOutputCapBytes,
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
  private get compactor(): Compactor | undefined {
    return this.container.has(TOKENS.Compactor)
      ? this.container.resolve(TOKENS.Compactor)
      : undefined;
  }
  private get renderer(): Renderer | undefined {
    return this.container.has(TOKENS.Renderer)
      ? this.container.resolve(TOKENS.Renderer)
      : undefined;
  }

  register(tool: Tool): void {
    this.tools.register(tool);
  }

  async use(plugin: Plugin, api: PluginAPI): Promise<void> {
    await plugin.setup(api);
    this.plugins.push({ plugin, api });
  }

  async run(userInput: AgentInput, opts: RunOptions = {}): Promise<RunResult> {
    const controller = new RunController({ parentSignal: opts.signal });
    const signal = controller.signal;
    this.ctx.signal = signal;
    // Flush abort hooks registered on the context when this run ends or
    // is aborted. Tools / MCP / file handles register via ctx.registerAbortHook.
    controller.onAbort(() => this.ctx.drainAbortHooks());

    try {
      return await this.runInner(userInput, opts, controller);
    } finally {
      await controller.dispose();
    }
  }

  private async runInner(
    userInput: AgentInput,
    opts: RunOptions,
    controller: RunController,
  ): Promise<RunResult> {
    await this.normalizeAndEmitUserInput(userInput);

    let finalText = '';
    let iterations = 0;
    let maxIter = opts.maxIterations ?? this.maxIterations;
    const hasHardLimit = maxIter > 0 && Number.isFinite(maxIter);

    for (let i = 0; ; i++) {
      iterations = i + 1;
      if (controller.signal.aborted) {
        return { status: 'aborted', iterations };
      }

      const limitResult = await this.checkIterationLimit(
        i,
        maxIter,
        hasHardLimit,
        iterations,
      );
      if (limitResult !== undefined) {
        return { ...limitResult, finalText };
      }

      this.events.emit('iteration.started', { ctx: this.ctx, index: i });

      const req = await this.buildAndRunRequestPipeline(opts);

      let res: Response;
      try {
        res = await this.callProviderWithRetry(this.ctx.provider, req, controller.signal);
      } catch (err) {
        if (controller.signal.aborted) {
          this.events.emit('error', { err: toError(err), phase: 'provider' });
          return { status: 'aborted', iterations, error: err };
        }
        const recovered = await this.errorHandler.recover(err, this.ctx);
        if (!recovered) {
          this.events.emit('error', { err: toError(err), phase: 'provider' });
          return { status: 'failed', iterations, error: err };
        }
        res = recovered;
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
    }
  }

  /**
   * Normalize user input and emit through userInput pipeline + session append.
   */
  private async normalizeAndEmitUserInput(userInput: AgentInput): Promise<void> {
    const { blocks, text } = normalizeInput(userInput);
    await this.pipelines.userInput.run({ content: blocks, text, ctx: this.ctx });
    this.ctx.messages.push({ role: 'user', content: blocks });
    await this.ctx.session.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: blocks,
    });
  }

  /**
   * Check if iteration limit has been reached and request extension if needed.
   * Returns RunResult if loop should exit, undefined otherwise.
   */
  private async checkIterationLimit(
    iterationIndex: number,
    maxIter: number,
    hasHardLimit: boolean,
    currentIterations: number,
  ): Promise<RunResult | undefined> {
    if (hasHardLimit && iterationIndex >= maxIter) {
      const extendBy = await this.requestLimitExtension(currentIterations);
      if (extendBy > 0) {
        maxIter += extendBy;
        this.logger.info(`Iteration limit extended by ${extendBy} (new limit: ${maxIter})`);
      } else {
        return { status: 'max_iterations', iterations: currentIterations };
      }
    }
    return undefined;
  }

  /**
   * Build request and run through request pipeline.
   */
  private async buildAndRunRequestPipeline(opts: RunOptions): Promise<Request> {
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
    res: Response,
    req: Request,
  ): Promise<{ finalText: string; aborted: boolean; done: boolean }> {
    const processedRes = await this.pipelines.response.run(res);
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
    this.ctx.messages.push({ role: 'assistant', content: res.content });
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
   */
  private async executeTools(toolUses: ToolUseBlock[]): Promise<void> {
    const { outputs } = await this.toolExecutor.executeBatch(
      toolUses,
      this.ctx,
      this.executionStrategy,
    );

    // Post-processing: pipeline, session, events
    const useById = new Map(toolUses.map((u) => [u.id, u]));
    for (const { result, tool, durationMs } of outputs) {
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
      this.events.emit('tool.executed', {
        name: use.name,
        durationMs,
        ok: !result.is_error,
        input: use.input,
        output: truncateForEvent(result.content),
      });
    }

    this.ctx.messages.push({ role: 'user', content: outputs.map((o) => o.result) });
  }

  /**
   * Run context window pipeline if compactor is present.
   */
  private async compactContextIfNeeded(): Promise<void> {
    if (this.compactor) {
      await this.pipelines.contextWindow.run(this.ctx);
    }
  }

  /**
   * Emit an event asking listeners (CLI/TUI) whether to extend the iteration
   * limit. Returns the number of additional iterations granted. If no listener
   * responds or the user declines, returns 0.
   */
  private async requestLimitExtension(currentIterations: number): Promise<number> {
    return new Promise((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(0);
        }
      }, 30_000);
      const wrappedDeny = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(0);
        }
      };
      const wrappedGrant = (extra: number) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(Math.max(0, extra));
        }
      };
      // Auto-extend when enabled (default). Listeners can still override by
      // calling deny() synchronously before this emit returns.
      if (this.autoExtendLimit) {
        this.events.emit('iteration.limit_reached', {
          currentIterations,
          currentLimit: this.maxIterations,
          grant: wrappedGrant,
          deny: wrappedDeny,
        });
        // Give listeners a tick to deny, then auto-grant.
        setImmediate(() => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            resolve(100);
          }
        });
      } else {
        this.events.emit('iteration.limit_reached', {
          currentIterations,
          currentLimit: this.maxIterations,
          grant: wrappedGrant,
          deny: wrappedDeny,
        });
      }
    });
  }

  /**
   * Consume a Provider.stream() into a Response, emitting text_delta and
   * tool_use lifecycle events to the EventBus as they arrive. Delegates to
   * streaming-response-builder.ts for actual event handling.
   */
  private async streamProviderToResponse(
    provider: Provider,
    req: Request,
    signal: AbortSignal,
  ): Promise<Response> {
    return streamProviderToResponse(provider, req, signal, this.ctx, this.events);
  }

  private async callProviderWithRetry(
    provider: Provider,
    req: Request,
    signal: AbortSignal,
  ): Promise<Response> {
    let attempt = 0;
    for (;;) {
      try {
        if (provider.capabilities.streaming) {
          return await this.streamProviderToResponse(provider, req, signal);
        }
        return await provider.complete(req, { signal });
      } catch (err) {
        if (signal.aborted) throw err;
        const isProviderErr = err instanceof ProviderError;
        const errAsErr = err instanceof Error ? err : new Error(String(err));
        const canRetry = this.retry.shouldRetry(isProviderErr ? err : errAsErr, attempt);
        const description = isProviderErr
          ? (err as ProviderError).describe()
          : errAsErr.message;
        if (!canRetry) {
          if (isProviderErr) {
            this.events.emit('provider.error', {
              providerId: (err as ProviderError).providerId,
              status: (err as ProviderError).status,
              description,
              retryable: false,
            });
          }
          throw err;
        }
        const delay = Math.round(this.retry.delayMs(attempt));
        const attemptNum = attempt + 1;
        this.logger.warn(
          `Provider retry ${attemptNum} in ${delay}ms — ${description}`,
        );
        if (isProviderErr) {
          this.events.emit('provider.retry', {
            providerId: (err as ProviderError).providerId,
            attempt: attemptNum,
            delayMs: delay,
            status: (err as ProviderError).status,
            description,
          });
        }
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, delay);
          const onAbort = () => {
            clearTimeout(t);
            reject(new Error('aborted'));
          };
          if (signal.aborted) onAbort();
          signal.addEventListener('abort', onAbort, { once: true });
        });
        attempt++;
      }
    }
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