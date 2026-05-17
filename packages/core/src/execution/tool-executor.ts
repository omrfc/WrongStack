import type { Context } from '../core/context.js';
import type { ToolResultBlock, ToolUseBlock } from '../types/blocks.js';
import type {
  ToolBatchResult,
  ToolConfirmPendingResult,
  ToolExecutionOutput,
  ToolExecutorOptions,
  ToolExecutorStrategy,
} from '../types/tool-executor.js';
import type { Tool } from '../types/tool.js';
import { createToolOutputSerializer } from '../utils/tool-output-serializer.js';

export class ToolExecutor {
  private readonly serializer;
  private readonly iterationTimeoutMs: number;

  constructor(
    private readonly registry: { get(name: string): Tool | undefined; list(): Tool[] },
    private opts: ToolExecutorOptions,
  ) {
    this.iterationTimeoutMs = opts.iterationTimeoutMs ?? 300_000;
    this.serializer = createToolOutputSerializer({
      perIterationOutputCapBytes: opts.perIterationOutputCapBytes ?? 100_000,
    });
  }

  /**
   * Clear the interactive confirm awaiter so the executor returns
   * `ToolConfirmPendingResult` instead of blocking on stdin. Used by
   * the CLI to switch from inline prompts (REPL) to event-driven
   * confirmation (TUI) at runtime.
   */
  clearConfirmAwaiter(): void {
    this.opts.confirmAwaiter = undefined;
  }

  /**
   * Execute a batch of tool uses using the configured strategy.
   * Returns the execution results and the remaining output budget.
   */
  async executeBatch(
    toolUses: ToolUseBlock[],
    ctx: Context,
    strategy: ToolExecutorStrategy,
  ): Promise<ToolBatchResult> {
    let budget = this.opts.perIterationOutputCapBytes ?? 100_000;

    const runOne = async (use: ToolUseBlock): Promise<ToolExecutionOutput> => {
      const start = Date.now();
      const tool = this.registry.get(use.name);

      // Fast path: unknown tool
      if (!tool) {
        const result = this.unknownToolResult(use, () => this.registry.list().map((t) => t.name));
        budget = this.decrementBudget(result, budget);
        return { result, tool, durationMs: Date.now() - start };
      }

      const decision = await this.opts.permissionPolicy.evaluate(tool, use.input, ctx);

      if (decision.permission === 'deny') {
        const result = this.deniedResult(use, decision.reason);
        budget = this.decrementBudget(result, budget);
        return { result, tool, durationMs: Date.now() - start };
      }

      if (decision.permission === 'confirm') {
        if (this.opts.confirmAwaiter) {
          const choice = await this.opts.confirmAwaiter(tool, use.input, use.id, tool.name);
          if (choice !== 'yes' && choice !== 'always') {
            const result = {
              type: 'tool_result' as const,
              tool_use_id: use.id,
              content: `Tool "${tool.name}" denied by user.`,
              is_error: true,
            };
            budget = this.decrementBudget(result, budget);
            return { result, tool, durationMs: Date.now() - start };
          }
          // fall through to execute
        } else {
          const suggestedPattern =
            this.subjectFor(tool.name, use.input, tool.subjectKey) ?? tool.name;
          const pending: ToolConfirmPendingResult = {
            type: 'tool_confirm_pending',
            toolUseId: use.id,
            toolName: tool.name,
            input: use.input,
            suggestedPattern,
          };
          return { result: pending, tool, durationMs: Date.now() - start };
        }
      }

      // permission === 'auto'
      // L1-C: trace each tool execution. Span is a no-op unless an OTel
      // adapter or other Tracer is bound — zero overhead by default.
      const span = this.opts.tracer?.startSpan(`tool.${tool.name}`, {
        'tool.name': tool.name,
        'tool.mutating': tool.mutating,
        'tool.permission': tool.permission,
      });
      try {
        const result = await this.executeTool(tool, use, ctx, budget);
        budget = this.decrementBudget(result, budget);
        span?.setAttribute('tool.is_error', !!result.is_error);
        span?.setAttribute(
          'tool.output_bytes',
          typeof result.content === 'string' ? result.content.length : 0,
        );
        return { result, tool, durationMs: Date.now() - start };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const scrubbed = this.opts.secretScrubber.scrub(msg);
        this.opts.renderer?.writeToolResult(tool.name, scrubbed, true);
        const result = {
          type: 'tool_result' as const,
          tool_use_id: use.id,
          content: `Tool "${tool.name}" threw: ${scrubbed}`,
          is_error: true,
        };
        budget = this.decrementBudget(result, budget);
        if (err instanceof Error) span?.recordError(err);
        span?.setAttribute('tool.is_error', true);
        return { result, tool, durationMs: Date.now() - start };
      } finally {
        span?.end();
      }
    };

    // Run a single tool but never let an exception propagate to the
    // gather() below — `runOne` is already try/catch-wrapped for the
    // execution phase, but the *pre*-execution paths (permission policy,
    // confirmAwaiter) are unguarded and an unexpected throw there would
    // collapse Promise.all and lose every sibling's output. Wrap each
    // call so a per-tool failure becomes a per-tool error result.
    const safeRun = async (use: ToolUseBlock): Promise<ToolExecutionOutput> => {
      try {
        return await runOne(use);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const scrubbed = this.opts.secretScrubber.scrub(msg);
        const result = {
          type: 'tool_result' as const,
          tool_use_id: use.id,
          content: `Tool "${use.name}" execution failed: ${scrubbed}`,
          is_error: true,
        };
        budget = this.decrementBudget(result, budget);
        return { result, tool: this.registry.get(use.name), durationMs: 0 };
      }
    };

    if (strategy === 'sequential') {
      const outputs: ToolExecutionOutput[] = [];
      for (const use of toolUses) {
        if (use) outputs.push(await safeRun(use));
      }
      return { outputs, remainingBudget: budget };
    }

    if (strategy === 'parallel') {
      const outputs = await Promise.all(toolUses.map((use) => safeRun(use)));
      return { outputs, remainingBudget: budget };
    }

    // smart: non-mutating in parallel, then mutating sequentially
    const nonMutating: ToolUseBlock[] = [];
    const mutating: ToolUseBlock[] = [];
    for (const use of toolUses) {
      if (!use) continue;
      const tool = this.registry.get(use.name);
      if (tool?.mutating) mutating.push(use);
      else nonMutating.push(use);
    }
    const firstPass = await Promise.all(nonMutating.map((use) => safeRun(use)));
    const secondPass: ToolExecutionOutput[] = [];
    for (const use of mutating) {
      secondPass.push(await safeRun(use));
    }
    return {
      outputs: [...firstPass, ...secondPass],
      remainingBudget: budget,
    };
  }

  /**
   * Execute a single tool with timeout, permission check, and output capping.
   * Emits `tool.started` via the injected EventBus (if any) right before
   * invoking the tool — closes the observability gap between "model decided
   * to call a tool" and "tool.executed".
   */
  async executeTool(
    tool: Tool,
    use: ToolUseBlock,
    ctx: Context,
    budget: number,
  ): Promise<ToolResultBlock> {
    this.opts.events?.emit('tool.started', {
      name: tool.name,
      id: use.id,
      input: use.input,
    });
    this.opts.renderer?.writeToolCall(tool.name, use.input);
    const output = await this.runWithTimeout(tool, use.input, ctx.signal, ctx, use.id);
    const text = this.serializer.serialize(output);
    const scrubbed = this.opts.secretScrubber.scrub(text);
    const { text: capped } = this.serializer.enforceCap(scrubbed, budget);
    this.opts.renderer?.writeToolResult(tool.name, capped, false);
    return {
      type: 'tool_result',
      tool_use_id: use.id,
      name: tool.name,
      content: capped,
      is_error: false,
    };
  }

  private async runWithTimeout(
    tool: Tool,
    input: unknown,
    parentSignal: AbortSignal,
    ctx: Context,
    toolUseId?: string,
  ): Promise<unknown> {
    if (parentSignal.aborted) {
      // Re-throw the original abort reason, whether it's an Error, string, or undefined.
      if (parentSignal.reason instanceof Error) throw parentSignal.reason;
      throw new Error(typeof parentSignal.reason === 'string' ? parentSignal.reason : 'aborted');
    }
    const timeoutMs = tool.timeoutMs ?? this.iterationTimeoutMs;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('tool timeout')), timeoutMs);
    const combined = AbortSignal.any([parentSignal, ctrl.signal]);
    try {
      // Streaming variant takes precedence — yields progress events, then
      // a final 'final' event with the typed output. Tools that don't
      // implement executeStream fall through to the standard execute path.
      if (typeof tool.executeStream === 'function') {
        return await this.runStreamedTool(tool, input, ctx, combined, toolUseId);
      }
      return await tool.execute(input, ctx, { signal: combined });
    } catch (err) {
      if (combined.aborted && typeof tool.cleanup === 'function') {
        // Best-effort cleanup; never let it mask the original error.
        try {
          await tool.cleanup(input, ctx);
        } catch {
          /* swallow */
        }
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async runStreamedTool(
    tool: Tool,
    input: unknown,
    ctx: Context,
    signal: AbortSignal,
    toolUseId: string | undefined,
  ): Promise<unknown> {
    let finalOutput: unknown;
    let sawFinal = false;
    const stream = tool.executeStream!(input, ctx, { signal });
    for await (const ev of stream) {
      if (ev.type === 'final') {
        finalOutput = ev.output;
        sawFinal = true;
        // Drain whatever the iterator wants to surface after final, but the
        // result is locked in. Most tools won't yield more.
        break;
      }
      this.opts.events?.emit('tool.progress', {
        name: tool.name,
        id: toolUseId ?? '<unknown>',
        event: ev,
      });
    }
    if (!sawFinal) {
      throw new Error(`tool "${tool.name}" executeStream completed without a 'final' event`);
    }
    return finalOutput;
  }

  private unknownToolResult(use: ToolUseBlock, listFns: () => string[]): ToolResultBlock {
    return {
      type: 'tool_result',
      tool_use_id: use.id,
      content: `Tool "${use.name}" is not registered. Available tools: ${listFns().join(', ')}`,
      is_error: true,
    };
  }

  private deniedResult(use: ToolUseBlock, reason?: string): ToolResultBlock {
    return {
      type: 'tool_result',
      tool_use_id: use.id,
      content: `Tool "${use.name}" denied: ${reason ?? 'policy'}`,
      is_error: true,
    };
  }

  private decrementBudget(result: ToolResultBlock, budget: number): number {
    const contentBytes =
      typeof result.content === 'string'
        ? Buffer.byteLength(result.content, 'utf8')
        : Buffer.byteLength(JSON.stringify(result.content), 'utf8');
    return Math.max(0, budget - contentBytes);
  }

  /**
   * Compute the suggestedPattern string for a tool+input pair.
   * Matches the logic in DefaultPermissionPolicy so the TUI shows the
   * same subject that the trust file would use.
   */
  private subjectFor(toolName: string, input: unknown, subjectKey?: string): string | undefined {
    if (!input || typeof input !== 'object') return undefined;
    const obj = input as Record<string, unknown>;
    const globChars = /[*?\[\]]/g;
    const escapeGlob = (s: string) => s.replace(globChars, (c) => `\\${c}`);
    const normalizePath = (s: string) => escapeGlob(s.replace(/\\/g, '/'));

    // Mirror DefaultPermissionPolicy.subjectFor — keep both in sync so the
    // TUI's "suggested pattern" matches what the trust file actually uses.
    if (subjectKey) {
      const v = obj[subjectKey];
      if (typeof v === 'string') {
        return subjectKey === 'path' || subjectKey === 'file' || subjectKey === 'files'
          ? normalizePath(v)
          : escapeGlob(v);
      }
    }

    if (toolName === 'bash' && typeof obj.command === 'string') {
      return escapeGlob(obj.command);
    }
    if (typeof obj.path === 'string') {
      return normalizePath(obj.path);
    }
    if (typeof obj.url === 'string') {
      return escapeGlob(obj.url);
    }
    if (typeof obj.name === 'string') {
      return escapeGlob(obj.name);
    }
    return undefined;
  }
}
