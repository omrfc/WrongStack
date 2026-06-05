/**
 * Response processing handler — extracted from Agent class.
 * Handles provider response pipeline, event emission, session
 * persistence, text rendering, and autonomous continuation parsing.
 */
import type { Request, Response } from '../types/provider.js';
import { isTextBlock } from '../types/blocks.js';
import { repairToolUseAdjacency } from '../utils/message-invariants.js';
import { parseContinueDirective, type ContinueDirective } from './continue-to-next-iteration.js';
import type { RunOptions } from './context.js';
import type { AgentInternals } from './agent-internals.js';

export interface ProcessResponseResult {
  finalText: string;
  aborted: boolean;
  done: boolean;
  directive?: ContinueDirective;
}

export interface AgentResponseHandler {
  buildAndRunRequestPipeline(opts: RunOptions): Promise<Request>;
  processResponse(raw: Response, req: Request): Promise<ProcessResponseResult>;
}

export function createAgentResponseHandler(a: AgentInternals): AgentResponseHandler {
  async function buildAndRunRequestPipeline(opts: RunOptions): Promise<Request> {
    const repaired = repairToolUseAdjacency(a.ctx.messages);
    if (repaired.report.changed) {
      a.ctx.state.replaceMessages(repaired.messages);
      a.events.emit('context.repaired', {
        ctx: a.ctx,
        ...repaired.report,
      });
      a.logger.warn(
        `Repaired context tool adjacency: removed ${repaired.report.removedToolUses.length} tool_use block(s), ` +
          `${repaired.report.removedToolResults.length} tool_result block(s), ` +
          `${repaired.report.removedMessages} empty message(s)`,
      );
    }
    const baseReq: Request = {
      model: opts.model ?? a.ctx.model,
      system: a.ctx.systemPrompt,
      messages: a.ctx.messages,
      tools: a.tools.list(),
      maxTokens: 8192,
    };
    return a.pipelines.request.run(baseReq);
  }

  async function processResponse(raw: Response, req: Request): Promise<ProcessResponseResult> {
    let res = raw;
    res = await a.pipelines.response.run(res);
    a.events.emit('provider.response', {
      ctx: a.ctx,
      usage: res.usage,
      stopReason: res.stopReason,
    });
    a.ctx.tokenCounter.account(res.usage, req.model);

    a.ctx.state.appendMessage({ role: 'assistant', content: res.content });
    await a.ctx.session.append({
      type: 'llm_response',
      ts: new Date().toISOString(),
      content: res.content,
      stopReason: res.stopReason,
      usage: res.usage,
    });

    if (a.ctx.signal.aborted) {
      let finalText = '';
      for (const block of res.content) {
        if (isTextBlock(block)) finalText += block.text;
      }
      return { finalText, aborted: true, done: false };
    }

    let finalText = '';
    const streamed = a.ctx.provider.capabilities.streaming;
    for (const block of res.content) {
      if (isTextBlock(block)) {
        const rendered = await a.pipelines.assistantOutput.run(block);
        finalText += rendered.text;
        if (!streamed) a.renderer?.write(rendered);
      }
    }

    let directive: ContinueDirective = 'none';
    if (finalText) {
      directive = parseContinueDirective(finalText);
    }

    return { finalText, aborted: false, done: false, directive };
  }

  return { buildAndRunRequestPipeline, processResponse };
}
