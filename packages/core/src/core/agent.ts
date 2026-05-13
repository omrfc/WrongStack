import { randomUUID } from 'node:crypto';
import type { Container, Token } from '../kernel/container.js';
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
    const signal = controller.signal;

    const { blocks, text } = normalizeInput(userInput);
    await this.pipelines.userInput.run({ content: blocks, text, ctx: this.ctx });
    this.ctx.messages.push({ role: 'user', content: blocks });
    await this.ctx.session.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: blocks,
    });

    let finalText = '';
    let iterations = 0;
    const maxIter = opts.maxIterations ?? this.maxIterations;

    for (let i = 0; i < maxIter; i++) {
      iterations = i + 1;
      if (signal.aborted) {
        return { status: 'aborted', iterations };
      }
      this.events.emit('iteration.started', { ctx: this.ctx, index: i });

      // Build request and run request pipeline
      const baseReq: Request = {
        model: opts.model ?? this.ctx.model,
        system: this.ctx.systemPrompt,
        messages: this.ctx.messages,
        tools: this.tools.list(),
        maxTokens: 8192,
      };
      const req = await this.pipelines.request.run(baseReq);

      // Provider call with retry
      let res: Response;
      try {
        res = await this.callProviderWithRetry(this.ctx.provider, req, signal);
      } catch (err) {
        if (signal.aborted) {
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
      this.ctx.messages.push({ role: 'assistant', content: res.content });
      await this.ctx.session.append({
        type: 'llm_response',
        ts: new Date().toISOString(),
        content: res.content,
        stopReason: res.stopReason,
        usage: res.usage,
      });
      if (signal.aborted) {
        // Accumulate any text the user did see so callers can show "you
        // got this much before cancelling" if they want.
        for (const block of res.content) {
          if (isTextBlock(block)) finalText += block.text;
        }
        this.events.emit('iteration.completed', { ctx: this.ctx, index: i });
        return { status: 'aborted', iterations, finalText };
      }

      // Render text blocks. For streaming providers the renderer already
      // saw the text via provider.text_delta events; we still run the
      // assistantOutput pipeline (for transforms) and accumulate finalText,
      // but we don't double-write to the renderer.
      const streamed = this.ctx.provider.capabilities.streaming;
      for (const block of res.content) {
        if (isTextBlock(block)) {
          const rendered = await this.pipelines.assistantOutput.run(block);
          finalText += rendered.text;
          if (!streamed) this.renderer?.write(rendered);
        }
      }

      const toolUses = res.content.filter(isToolUseBlock);
      if (toolUses.length === 0 || res.stopReason === 'end_turn') {
        this.events.emit('iteration.completed', { ctx: this.ctx, index: i });
        return { status: 'done', iterations, finalText };
      }

      // Execute tools
      const results = await this.executeTools(toolUses, signal);
      this.ctx.messages.push({ role: 'user', content: results });
      this.events.emit('iteration.completed', { ctx: this.ctx, index: i });

      // Context-window check: only run the pipeline when a compactor is present.
      // The compactor itself decides whether to actually compact based on the
      // token threshold, so this always runs when the compactor is configured.
      if (this.compactor) {
        await this.pipelines.contextWindow.run(this.ctx);
      }
    }

    return { status: 'max_iterations', iterations, finalText };
  }

  /**
   * Consume a Provider.stream() into a Response, emitting text_delta and
   * tool_use lifecycle events to the EventBus as they arrive. This is the
   * canonical path when the provider declares `capabilities.streaming`;
   * complete() is only used as a fallback for legacy providers.
   */
  private async streamProviderToResponse(
    provider: Provider,
    req: Request,
    signal: AbortSignal,
  ): Promise<Response> {
    let model = req.model;
    let stopReason: Response['stopReason'] = 'end_turn';
    let usage: Response['usage'] = { input: 0, output: 0 };
    const textBuffers: string[] = [];
    let currentTextIndex = -1;
    // tool_input_chunks[id] accumulates raw deltas. We store as string for
    // JSON-expected inputs; callers that need binary should handle Uint8Array.
    const tools = new Map<string, { name: string; partial: string; input?: unknown }>();
    const blockOrder: Array<{ kind: 'text'; idx: number } | { kind: 'tool'; id: string }> = [];
    // Track open content blocks for providers that emit content_block_start/stop
    // (e.g. Anthropic). This lets us handle interleaved text + tool sequences.
    const openContentBlocks = new Map<string, 'text' | 'tool'>();

    const buildResponse = (): Response => {
      const content: import('../types/blocks.js').ContentBlock[] = [];
      for (const b of blockOrder) {
        if (b.kind === 'text') {
          const txt = textBuffers[b.idx] ?? '';
          if (txt) content.push({ type: 'text', text: txt });
        } else {
          const tb = tools.get(b.id);
          if (tb) {
            content.push({
              type: 'tool_use',
              id: b.id,
              name: tb.name,
              input: (tb.input as Record<string, unknown>) ?? {},
            });
          }
        }
      }
      if (content.length === 0) content.push({ type: 'text', text: '' });
      return { content, stopReason, usage, model };
    };

    const iter = provider.stream(req, { signal })[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await iter.next();
        if (next.done) break;
        const ev = next.value;
        switch (ev.type) {
          case 'message_start':
            model = ev.model;
            break;
          case 'content_block_start': {
            // Anthropic-style framing: each block starts with this event before its deltas.
            const kind = (ev as { kind: string }).kind ?? 'text';
            if (kind === 'text') {
              currentTextIndex = textBuffers.length;
              textBuffers.push('');
              blockOrder.push({ kind: 'text', idx: currentTextIndex });
              openContentBlocks.set(`block_${currentTextIndex}`, 'text');
            } else if (kind === 'tool_use') {
              const id = (ev as { id: string }).id ?? crypto.randomUUID();
              tools.set(id, { name: (ev as { name: string }).name ?? 'unknown', partial: '' });
              blockOrder.push({ kind: 'tool', id });
              openContentBlocks.set(id, 'tool');
            }
            break;
          }
          case 'content_block_stop': {
            // Finalize the block that was started by content_block_start.
            openContentBlocks.delete((ev as { index: number }).index?.toString() ?? '');
            break;
          }
          case 'text_delta':
            if (currentTextIndex === -1) {
              currentTextIndex = textBuffers.length;
              textBuffers.push('');
              blockOrder.push({ kind: 'text', idx: currentTextIndex });
            }
            textBuffers[currentTextIndex] = (textBuffers[currentTextIndex] ?? '') + ev.text;
            this.events.emit('provider.text_delta', { ctx: this.ctx, text: ev.text });
            break;
          case 'tool_use_start':
            currentTextIndex = -1;
            tools.set(ev.id, { name: ev.name, partial: '' });
            blockOrder.push({ kind: 'tool', id: ev.id });
            this.events.emit('provider.tool_use_start', {
              ctx: this.ctx,
              id: ev.id,
              name: ev.name,
            });
            break;
          case 'tool_use_input_delta': {
            const t = tools.get(ev.id);
            if (t) t.partial += ev.partial;
            break;
          }
          case 'tool_use_stop': {
            const t = tools.get(ev.id);
            if (t) {
              t.input = ev.input !== undefined ? ev.input : safeJsonOrRaw(t.partial);
            }
            currentTextIndex = -1;
            this.events.emit('provider.tool_use_stop', { ctx: this.ctx, id: ev.id });
            break;
          }
          case 'message_stop':
            stopReason = ev.stopReason;
            usage = ev.usage;
            break;
        }
      }
    } catch (err) {
      // If we were aborted mid-stream, surface what we managed to collect.
      // The agent loop branches on signal.aborted and persists this as a
      // partial assistant message so the next turn has the context.
      if (signal.aborted) {
        stopReason = 'max_tokens'; // closest canonical "interrupted" signal
        return buildResponse();
      }
      throw err;
    } finally {
      // Release the underlying body reader / HTTP socket. Without this an
      // aborted run can leak undici handles on Windows (UV_HANDLE_CLOSING).
      try {
        await iter.return?.();
      } catch {
        // best-effort
      }
    }
    return buildResponse();
  }

  private async callProviderWithRetry(
    provider: Provider,
    req: Request,
    signal: AbortSignal,
  ): Promise<Response> {
    let attempt = 0;
    let lastErr: unknown;
    for (;;) {
      try {
        if (provider.capabilities.streaming) {
          return await this.streamProviderToResponse(provider, req, signal);
        }
        return await provider.complete(req, { signal });
      } catch (err) {
        lastErr = err;
        if (signal.aborted) throw err;
        const isProviderErr = err instanceof ProviderError;
        const errAsErr = err instanceof Error ? err : new Error(String(err));
        const canRetry = this.retry.shouldRetry(isProviderErr ? err : errAsErr, attempt);
        if (!canRetry) throw err;
        const delay = this.retry.delayMs(attempt);
        this.logger.warn(`Provider call retry ${attempt + 1} after ${delay}ms`, {
          err: errAsErr.message,
        });
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
    // reachable in test environments where signal is never aborted
    // biome-ignore lint/correctness/noUnreachable: intended fallthrough
    throw lastErr;
  }

  private async executeTools(
    toolUses: ToolUseBlock[],
    signal: AbortSignal,
  ): Promise<ToolResultBlock[]> {
    const results = new Array<ToolResultBlock>(toolUses.length);
    let outputBudget = this.perIterationOutputCapBytes;

    const runOne = async (use: ToolUseBlock, index: number): Promise<void> => {
      const start = Date.now();
      const tool = this.tools.get(use.name);
      let result: ToolResultBlock;
      if (!tool) {
        result = {
          type: 'tool_result',
          tool_use_id: use.id,
          content: `Tool "${use.name}" is not registered. Available tools: ${this.tools
            .list()
            .map((t) => t.name)
            .join(', ')}`,
          is_error: true,
        };
      } else {
        try {
          const decision = await this.permission.evaluate(tool, use.input, this.ctx);
          if (decision.permission === 'deny') {
            result = {
              type: 'tool_result',
              tool_use_id: use.id,
              content: `Tool "${use.name}" denied: ${decision.reason ?? 'policy'}`,
              is_error: true,
            };
          } else if (decision.permission === 'confirm') {
            result = {
              type: 'tool_result',
              tool_use_id: use.id,
              content: `Tool "${use.name}" requires user confirmation but no prompt handler was available.`,
              is_error: true,
            };
          } else {
            this.renderer?.writeToolCall(use.name, use.input);
            const output = await this.runToolWithTimeout(tool, use.input, signal);
            const text = serialize(output);
            const scrubbed = this.scrubber.scrub(text);
            const capped = enforceCap(scrubbed, outputBudget);
            outputBudget = Math.max(0, outputBudget - capped.length);
            result = {
              type: 'tool_result',
              tool_use_id: use.id,
              content: capped,
              is_error: false,
            };
            this.renderer?.writeToolResult(use.name, capped, false);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result = {
            type: 'tool_result',
            tool_use_id: use.id,
            content: `Tool "${use.name}" threw: ${msg}`,
            is_error: true,
          };
          this.renderer?.writeToolResult(use.name, msg, true);
        }
      }
      // Run tool-call pipeline
      await this.pipelines.toolCall.run({
        toolUse: use,
        result,
        ctx: this.ctx,
        tool: tool ?? undefined,
      });
      await this.ctx.session.append({
        type: 'tool_result',
        ts: new Date().toISOString(),
        id: use.id,
        content: result.content,
        isError: !!result.is_error,
      });
      this.events.emit('tool.executed', {
        name: use.name,
        durationMs: Date.now() - start,
        ok: !result.is_error,
        input: use.input,
      });
      results[index] = result;
    };

    // Execution strategy
    if (this.executionStrategy === 'sequential') {
      for (let i = 0; i < toolUses.length; i++) {
        const use = toolUses[i];
        if (use) await runOne(use, i);
      }
    } else if (this.executionStrategy === 'parallel') {
      await Promise.all(toolUses.map((use, i) => runOne(use, i)));
    } else {
      // smart: non-mutating in parallel, then mutating sequentially
      const nonMutating: { use: ToolUseBlock; index: number }[] = [];
      const mutating: { use: ToolUseBlock; index: number }[] = [];
      for (let i = 0; i < toolUses.length; i++) {
        const use = toolUses[i];
        if (!use) continue;
        const tool = this.tools.get(use.name);
        if (tool?.mutating) mutating.push({ use, index: i });
        else nonMutating.push({ use, index: i });
      }
      await Promise.all(nonMutating.map(({ use, index }) => runOne(use, index)));
      for (const { use, index } of mutating) {
        await runOne(use, index);
      }
    }
    return results;
  }

  private async runToolWithTimeout(
    tool: Tool,
    input: unknown,
    parentSignal: AbortSignal,
  ): Promise<unknown> {
    const timeoutMs = tool.timeoutMs ?? this.iterationTimeoutMs;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('tool timeout')), timeoutMs);
    const combined = anySignal([parentSignal, ctrl.signal]);
    try {
      const out = await tool.execute(input, this.ctx, { signal: combined });
      return out;
    } finally {
      clearTimeout(timer);
    }
  }
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  if ('any' in AbortSignal && typeof (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any === 'function') {
    return (AbortSignal as { any: (s: AbortSignal[]) => AbortSignal }).any(signals);
  }
  const ctrl = new AbortController();
  const abortSources: AbortSignal[] = [];
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      return ctrl.signal;
    }
    abortSources.push(s);
  }
  for (const s of abortSources) {
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

function serialize(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (Array.isArray(value)) return value.map(serialize).join('\n');
    if ('text' in (value as Record<string, unknown>)) {
      const t = (value as Record<string, unknown>).text;
      // If .text is a string, return it directly; otherwise fall through to
      // JSON.stringify so nested objects don't become "[object Object]".
      return typeof t === 'string' ? t : JSON.stringify(value, null, 2);
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function enforceCap(text: string, capBytes: number): string {
  if (capBytes <= 0) return '[truncated: iteration output cap exceeded]';
  const textBytes = Buffer.byteLength(text, 'utf8');
  if (textBytes <= capBytes) return text;
  // Pre-calculate the truncation message byte size so the final output
  // does not exceed capBytes by more than a few bytes.
  const marker = `\n…[truncated ${textBytes - capBytes} bytes]…\n`;
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const available = capBytes - markerBytes;
  if (available <= 0) return '[truncated: iteration output cap exceeded]';
  const half = Math.floor(available / 2);
  return `${text.slice(0, half)}${marker}${text.slice(textBytes - half)}`;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function safeJsonOrRaw(s: string): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
}

// Keep crypto import live so meta hooks can use it.
export { randomUUID };
export type { Token };

