/**
 * Tool execution handler — extracted from Agent class for testability.
 * Handles batch tool execution, confirmation flow, and post-execution
 * pipeline/session/event emission.
 */
import type { ToolUseBlock, ToolResultBlock } from '../types/blocks.js';
import type { Tool } from '../types/tool.js';
import { sizeSignals, truncateForEvent } from '../utils/tool-output-serializer.js';
import type { AgentInternals } from './agent-internals.js';

export interface AgentToolHandler {
  executeTools(toolUses: ToolUseBlock[]): Promise<ToolResultBlock[]>;
  executeSingleWithDecision(
    tool: Tool,
    use: { id: string; name: string; input: unknown },
  ): Promise<{ result: ToolResultBlock; durationMs: number }>;
}

export function createAgentToolHandler(a: AgentInternals): AgentToolHandler {
  async function executeSingleWithDecision(
    tool: Tool,
    use: { id: string; name: string; input: unknown },
  ): Promise<{ result: ToolResultBlock; durationMs: number }> {
    const start = Date.now();
    try {
      const result = await a.toolExecutor.executeTool(
        tool,
        use as ToolUseBlock,
        a.ctx,
        a.perIterationOutputCapBytes,
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

  function waitForConfirm(info: {
    tool: Tool;
    input: unknown;
    toolUseId: string;
    suggestedPattern: string;
  }): Promise<'yes' | 'no' | 'always' | 'deny'> {
    return new Promise((resolve) => {
      a.events.emit('tool.confirm_needed', {
        tool: info.tool,
        input: info.input,
        toolUseId: info.toolUseId,
        suggestedPattern: info.suggestedPattern,
        resolve,
      });
    });
  }

  function emitToolExecuted(
    toolUseId: string,
    toolName: string,
    durationMs: number,
    ok: boolean,
    input: unknown,
    content: string,
  ): void {
    const sig = sizeSignals(toolName, content);
    a.events.emit('tool.executed', {
      id: toolUseId,
      name: toolName,
      durationMs,
      ok,
      input,
      output: truncateForEvent(content),
      outputBytes: sig.outputBytes,
      outputTokens: sig.outputTokens,
      outputLines: sig.outputLines,
    });
  }

  async function executeTools(toolUses: ToolUseBlock[]): Promise<ToolResultBlock[]> {
    const selectedToolUses = await a.extensions.runBeforeToolExecution(a.ctx, toolUses);

    const { outputs } = await a.toolExecutor.executeBatch(
      selectedToolUses,
      a.ctx,
      a.executionStrategy,
    );

    const useById = new Map(selectedToolUses.map((u) => [u.id, u]));
    const resultsForMessage: ToolResultBlock[] = [];

    for (const { result, tool, durationMs } of outputs) {
      if (result.type === 'tool_confirm_pending') {
        const decision = await waitForConfirm({
          tool: tool!,
          input: result.input,
          toolUseId: result.toolUseId,
          suggestedPattern: result.suggestedPattern,
        });

        // Persist trust/deny rules
        if (decision === 'always') {
          try {
            await a.permission.trust({ tool: tool!.name, pattern: result.suggestedPattern });
            a.events.emit('trust.persisted', { tool: tool!.name, pattern: result.suggestedPattern, decision });
          } catch { /* best-effort */ }
        } else if (decision === 'deny') {
          try {
            await a.permission.deny({ tool: tool!.name, pattern: result.suggestedPattern });
            a.events.emit('trust.persisted', { tool: tool!.name, pattern: result.suggestedPattern, decision });
          } catch { /* best-effort */ }
        }

        // Soft allow/deny for session-scoped retry prevention
        if (decision === 'yes') {
          const p = a.permission as unknown as { allowOnce?(r: { tool: string; pattern: string }): void };
          p.allowOnce?.({ tool: tool!.name, pattern: result.suggestedPattern });
        } else if (decision === 'no') {
          const p = a.permission as unknown as { denyOnce?(r: { tool: string; pattern: string }): void };
          p.denyOnce?.({ tool: tool!.name, pattern: result.suggestedPattern });
        }

        const reRunResult =
          decision === 'yes' || decision === 'always'
            ? await executeSingleWithDecision(tool!, {
                id: result.toolUseId,
                name: tool!.name,
                input: result.input,
              })
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
          await a.pipelines.toolCall.run({ toolUse: use, result: reRunResult.result, ctx: a.ctx, tool });
          await a.ctx.session.append({
            type: 'tool_result',
            ts: new Date().toISOString(),
            id: reRunResult.result.tool_use_id,
            content: reRunResult.result.content,
            isError: !!reRunResult.result.is_error,
          });
          emitToolExecuted(
            reRunResult.result.tool_use_id,
            tool!.name,
            reRunResult.durationMs,
            !reRunResult.result.is_error,
            result.input,
            reRunResult.result.content,
          );
        }
        resultsForMessage.push(reRunResult.result);
        continue;
      }

      // Non-pending: already a resolved tool_result
      resultsForMessage.push(result);
      const use = useById.get(result.tool_use_id);
      if (!use) continue;
      await a.pipelines.toolCall.run({ toolUse: use, result, ctx: a.ctx, tool: tool ?? undefined });
      await a.ctx.session.append({
        type: 'tool_result',
        ts: new Date().toISOString(),
        id: result.tool_use_id,
        content: result.content,
        isError: !!result.is_error,
      });
      emitToolExecuted(result.tool_use_id, use.name, durationMs, !result.is_error, use.input, result.content);
    }

    a.ctx.state.appendMessage({ role: 'user', content: resultsForMessage });
    await a.extensions.runAfterToolExecution(a.ctx, outputs);
    return resultsForMessage;
  }

  return { executeTools, executeSingleWithDecision };
}
