import type { Context } from '../core/context.js';
import type { Tool } from '../types/tool.js';
import type { ToolResultBlock, ToolUseBlock } from '../types/blocks.js';
import type {
  ToolExecutorOptions,
  ToolExecutorStrategy,
  ToolBatchResult,
  ToolExecutionOutput,
} from '../types/tool-executor.js';
import { createToolOutputSerializer } from '../utils/tool-output-serializer.js';

export class ToolExecutor {
  private readonly serializer;
  private readonly iterationTimeoutMs: number;

  constructor(
    private readonly registry: { get(name: string): Tool | undefined; list(): Tool[] },
    private readonly opts: ToolExecutorOptions,
  ) {
    this.iterationTimeoutMs = opts.iterationTimeoutMs ?? 300_000;
    this.serializer = createToolOutputSerializer({
      perIterationOutputCapBytes: opts.perIterationOutputCapBytes ?? 100_000,
    });
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

    const runOne = async (use: ToolUseBlock, index: number): Promise<ToolExecutionOutput> => {
      const start = Date.now();
      const tool = this.registry.get(use.name);
      let result: ToolResultBlock;

      if (!tool) {
        result = this.unknownToolResult(use, () => this.registry.list().map((t) => t.name));
      } else {
        const decision = await this.opts.permissionPolicy.evaluate(tool, use.input, ctx);
        if (decision.permission === 'deny') {
          result = this.deniedResult(use, decision.reason);
        } else if (decision.permission === 'confirm') {
          result = this.confirmResult(use);
        } else {
          try {
            result = await this.executeTool(tool, use, ctx, budget);
          } catch (err) {
            // Capture the throw as a structured error tool_result so the
            // agent loop continues. Without this, one bad tool would reject
            // Promise.all and abort the whole batch.
            const msg = err instanceof Error ? err.message : String(err);
            const scrubbed = this.opts.secretScrubber.scrub(msg);
            this.opts.renderer?.writeToolResult(tool.name, scrubbed, true);
            result = {
              type: 'tool_result',
              tool_use_id: use.id,
              content: `Tool "${use.name}" threw: ${scrubbed}`,
              is_error: true,
            };
          }
        }
      }

      const contentBytes =
        typeof result.content === 'string'
          ? Buffer.byteLength(result.content, 'utf8')
          : Buffer.byteLength(JSON.stringify(result.content), 'utf8');
      budget = Math.max(0, budget - contentBytes);
      return { result, tool, durationMs: Date.now() - start };
    };

    if (strategy === 'sequential') {
      const outputs: ToolExecutionOutput[] = [];
      for (let i = 0; i < toolUses.length; i++) {
        const use = toolUses[i];
        if (use) outputs.push(await runOne(use, i));
      }
      return { outputs, remainingBudget: budget };
    }

    if (strategy === 'parallel') {
      const outputs = await Promise.all(toolUses.map((use, i) => runOne(use, i)));
      return { outputs, remainingBudget: budget };
    }

    // smart: non-mutating in parallel, then mutating sequentially
    const nonMutating: { use: ToolUseBlock; index: number }[] = [];
    const mutating: { use: ToolUseBlock; index: number }[] = [];
    for (let i = 0; i < toolUses.length; i++) {
      const use = toolUses[i];
      if (!use) continue;
      const tool = this.registry.get(use.name);
      if (tool?.mutating) mutating.push({ use, index: i });
      else nonMutating.push({ use, index: i });
    }
    const firstPass = await Promise.all(nonMutating.map(({ use, index }) => runOne(use, index)));
    const secondPass: ToolExecutionOutput[] = [];
    for (const { use, index } of mutating) {
      secondPass.push(await runOne(use, index));
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
    const output = await this.runWithTimeout(tool, use.input, ctx.signal, ctx);
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
  ): Promise<unknown> {
    if (parentSignal.aborted) {
      throw parentSignal.reason instanceof Error
        ? parentSignal.reason
        : new Error(typeof parentSignal.reason === 'string' ? parentSignal.reason : 'aborted');
    }
    const timeoutMs = tool.timeoutMs ?? this.iterationTimeoutMs;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('tool timeout')), timeoutMs);
    const combined = anySignal([parentSignal, ctrl.signal]);
    try {
      return await tool.execute(input, ctx, { signal: combined });
    } finally {
      clearTimeout(timer);
    }
  }

  private unknownToolResult(
    use: ToolUseBlock,
    listFns: () => string[],
  ): ToolResultBlock {
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

  private confirmResult(use: ToolUseBlock): ToolResultBlock {
    return {
      type: 'tool_result',
      tool_use_id: use.id,
      content: `Tool "${use.name}" requires user confirmation but no prompt handler was available.`,
      is_error: true,
    };
  }
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  // AbortSignal.any is available in Node 22+. Use typeof to check if it's
  // actually implemented (it's defined as undefined before implementation,
  // so 'any' in AbortSignal is always truthy but typeof check is reliable).
  if (
    typeof AbortSignal.any === 'function'
  ) {
    return AbortSignal.any(signals);
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