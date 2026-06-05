/**
 * Agent loop handler — extracted from Agent class.
 * Contains runInner (the main iteration loop), checkIterationLimit,
 * compactContextIfNeeded, emitContextPct, and injectPendingBtwNotes.
 */
import type { Request, Response } from '../types/provider.js';
import type { ContentBlock, TextBlock } from '../types/blocks.js';
import { isToolUseBlock } from '../types/blocks.js';
import { toWrongStackError } from '../types/errors.js';
import { estimateRequestTokens, estimateRequestTokensCalibrated, recordActualUsage } from '../utils/token-estimate.js';
import { consumeAutonomousContinue } from './continue-to-next-iteration.js';
import { buildBtwBlock, consumeBtwNotes } from './btw.js';
import { runProviderWithRetry } from './provider-runner.js';
import { requestLimitExtension } from './iteration-limit.js';
import { TOKENS } from '../kernel/tokens.js';
import { RunController } from '../kernel/run-controller.js';
import type { RunOptions } from './context.js';
import type { RunResult, UserInputPayload } from './agent-types.js';
import type { AgentInternals } from './agent-internals.js';
import type { AgentToolHandler } from './agent-tools.js';
import type { AgentResponseHandler } from './agent-response.js';

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

interface LoopHandlers {
  tools: AgentToolHandler;
  response: AgentResponseHandler;
}

export interface AgentLoopHandler {
  runInner(
    inputPayload: UserInputPayload,
    opts: RunOptions,
    controller: RunController,
    autonomousContinue: boolean,
  ): Promise<RunResult>;
}

export function createAgentLoopHandler(
  a: AgentInternals,
  handlers: LoopHandlers,
): AgentLoopHandler {
  /** Run context window pipeline. */
  async function compactContextIfNeeded(): Promise<void> {
    await a.pipelines.contextWindow.run(a.ctx);
  }

  /** Emit ctx.pct event for live context-fill bar in UIs. */
  function emitContextPct(): void {
    const maxContext = a.ctx.provider.capabilities.maxContext ?? 200_000;
    const { total } = estimateRequestTokens(a.ctx.messages, a.ctx.systemPrompt, a.ctx.tools ?? []);
    a.events.emit('ctx.pct', { load: total / maxContext, tokens: total, maxContext });
  }

  /** Fold pending /btw notes into conversation before each iteration. */
  function injectPendingBtwNotes(): void {
    const notes = consumeBtwNotes(a.ctx);
    if (notes.length === 0) return;
    const block: TextBlock = { type: 'text', text: buildBtwBlock(notes) };

    const messages = a.ctx.messages;
    const last = messages[messages.length - 1];
    if (last && last.role === 'user') {
      const content: ContentBlock[] =
        typeof last.content === 'string'
          ? [{ type: 'text', text: last.content }, block]
          : [...last.content, block];
      a.ctx.state.replaceMessages([...messages.slice(0, -1), { ...last, content }]);
    } else {
      a.ctx.state.appendMessage({ role: 'user', content: [block] });
    }
  }

  /**
   * Check if iteration limit reached and request extension if needed.
   */
  async function checkIterationLimit(
    iterationIndex: number,
    limit: number,
    hasHardLimit: boolean,
    currentIterations: number,
    delegateSummaries: Array<{ summary: string; ok: boolean }>,
  ): Promise<{ limit: number; exit?: RunResult }> {
    if (hasHardLimit && iterationIndex >= limit) {
      const extendBy = await requestLimitExtension({
        events: a.events,
        currentIterations,
        currentLimit: limit,
        autoExtend: a.autoExtendLimit,
      });
      if (extendBy > 0) {
        const newLimit = limit + extendBy;
        a.logger.info(`Iteration limit extended by ${extendBy} (new limit: ${newLimit})`);
        return { limit: newLimit };
      }
      return { limit, exit: { status: 'max_iterations', iterations: currentIterations, delegateSummaries } };
    }
    return { limit };
  }

  async function runInner(
    inputPayload: UserInputPayload,
    opts: RunOptions,
    controller: RunController,
    autonomousContinue: boolean,
  ): Promise<RunResult> {
    await a.pipelines.userInput.run(inputPayload);
    a.ctx.state.appendMessage({ role: 'user', content: inputPayload.content });
    await a.ctx.session.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: inputPayload.content,
    });

    const promptIndex = a.ctx.messages.filter((m) => m.role === 'user').length - 1;
    const preview = inputPayload.text.slice(0, 80) + (inputPayload.text.length > 80 ? '…' : '');
    await a.ctx.session.writeCheckpoint(promptIndex, preview);

    let finalText = '';
    let iterations = 0;
    const delegateSummaries: Array<{ summary: string; ok: boolean }> = [];
    let effectiveLimit = opts.maxIterations ?? a.maxIterations;
    const hasHardLimit = effectiveLimit > 0 && Number.isFinite(effectiveLimit);
    let recoveryRetries = 0;

    const onSubagentDone = ({ summary, ok }: { summary: string; ok: boolean }) => {
      delegateSummaries.push({ summary, ok });
    };
    const offSubagentDone = a.events.on('subagent.done', onSubagentDone);

    // Build the base provider runner
    const diRunner = a.container.has(TOKENS.ProviderRunner)
      ? a.container.resolve(TOKENS.ProviderRunner)
      : null;

    const baseRunner = diRunner
      ? (ctx: typeof a.ctx, req: Request) =>
          diRunner.run({
            provider: ctx.provider, request: req, signal: controller.signal,
            ctx, events: a.events, retry: a.retry, logger: a.logger, tracer: a.tracer,
          })
      : async (ctx: typeof a.ctx, req: Request) =>
          runProviderWithRetry({
            provider: ctx.provider, request: req, signal: controller.signal,
            ctx, events: a.events, retry: a.retry, logger: a.logger, tracer: a.tracer,
          });

    const customRunner = a.extensions.wrapProviderRunner(baseRunner);

    try {
      for (let i = 0; ; i++) {
        iterations = i + 1;
        if (controller.signal.aborted) {
          return { status: 'aborted', iterations };
        }

        await a.ctx.session
          .writeInFlightMarker(`iteration ${i} / max ${a.maxIterations}`)
          .catch((err) => {
            a.logger.debug?.(
              `in-flight marker write failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });

        if (autonomousContinue) {
          consumeAutonomousContinue(a.ctx);
        }

        const limitCheck = await checkIterationLimit(
          i, effectiveLimit, hasHardLimit, iterations, delegateSummaries,
        );
        effectiveLimit = limitCheck.limit;
        if (limitCheck.exit) {
          return { ...limitCheck.exit, finalText };
        }

        await a.extensions.runBeforeIteration(a.ctx, i);
        a.events.emit('iteration.started', { ctx: a.ctx, index: i });

        injectPendingBtwNotes();

        const req = await handlers.response.buildAndRunRequestPipeline(opts);

        await a.ctx.session.append({
          type: 'llm_request',
          ts: new Date().toISOString(),
          model: req.model,
          messageCount: req.messages.length,
          estimatedInputTokens: estimateRequestTokens(req.messages, req.system, req.tools ?? []).total,
          toolCount: (req.tools ?? []).length,
        }).catch(() => { /* best-effort */ });

        let res: Response;
        try {
          res = await customRunner(a.ctx, req);
          const calibratedEstimate = estimateRequestTokensCalibrated(req.messages, req.system, req.tools ?? []).total;
          recordActualUsage(res.usage.input, calibratedEstimate);
          recoveryRetries = 0;
        } catch (err) {
          if (controller.signal.aborted) {
            a.events.emit('error', { err: toError(err), phase: 'provider' });
            return { status: 'aborted', iterations, error: toWrongStackError(err, 'AGENT_ABORTED') };
          }

          const extDecision = await a.extensions.runOnError(a.ctx, err, 'provider', i);
          if (extDecision) {
            if (extDecision.action === 'fail') {
              a.events.emit('error', { err: toError(err), phase: 'provider' });
              return { status: 'failed', iterations, error: toWrongStackError(err), delegateSummaries };
            }
            if (extDecision.action === 'continue') {
              await a.extensions.runAfterIteration(a.ctx, i);
              continue;
            }
            if (extDecision.action === 'retry') {
              recoveryRetries++;
              if (recoveryRetries > 2) {
                a.events.emit('error', { err: toError(err), phase: 'provider' });
                return { status: 'failed', iterations, error: toWrongStackError(err), delegateSummaries };
              }
              if (extDecision.model) a.ctx.model = extDecision.model;
              a.logger.info('Extension requested retry; retrying turn');
              continue;
            }
          }

          const recovered = await a.errorHandler.recover(err, a.ctx);
          if (!recovered || recovered.action === 'fail') {
            a.events.emit('error', { err: toError(err), phase: 'provider' });
            return {
              status: 'failed', iterations,
              error: toWrongStackError(recovered?.error ?? err),
              delegateSummaries,
            };
          }
          if (recovered.action === 'retry') {
            recoveryRetries++;
            if (recoveryRetries > 2) {
              a.events.emit('error', { err: toError(err), phase: 'provider' });
              return { status: 'failed', iterations, error: toWrongStackError(err) };
            }
            if (recovered.model) a.ctx.model = recovered.model;
            a.logger.info(`Recovered provider error via ${recovered.reason}; retrying turn`);
            continue;
          }
          recoveryRetries = 0;
          res = recovered.response;
        }

        const responseResult = await handlers.response.processResponse(res, req);
        if (responseResult.aborted) {
          return { status: 'aborted', iterations, finalText: responseResult.finalText, delegateSummaries };
        }
        if (responseResult.done) {
          return { status: 'done', iterations, finalText: responseResult.finalText, delegateSummaries };
        }

        finalText = responseResult.finalText;

        const toolUses = res.content.filter(isToolUseBlock);
        if (toolUses.length === 0) {
          emitContextPct();
          a.events.emit('iteration.completed', { ctx: a.ctx, index: i });
          if (autonomousContinue && responseResult.directive === 'continue') {
            await compactContextIfNeeded();
            await a.extensions.runAfterIteration(a.ctx, i);
            continue;
          }
          if (autonomousContinue && responseResult.directive === 'stop') {
            return { status: 'done', iterations, finalText, delegateSummaries };
          }
          return { status: 'done', iterations, finalText, delegateSummaries };
        }

        await handlers.tools.executeTools(toolUses);

        if (autonomousContinue && consumeAutonomousContinue(a.ctx)) {
          emitContextPct();
          a.events.emit('iteration.completed', { ctx: a.ctx, index: i });
          await compactContextIfNeeded();
          await a.extensions.runAfterIteration(a.ctx, i);
          continue;
        }

        emitContextPct();
        a.events.emit('iteration.completed', { ctx: a.ctx, index: i });
        await compactContextIfNeeded();
        await a.extensions.runAfterIteration(a.ctx, i);

        if (autonomousContinue && responseResult.directive === 'continue') {
          continue;
        }
        if (autonomousContinue && responseResult.directive === 'stop') {
          return { status: 'done', iterations, finalText, delegateSummaries };
        }
      }
    } finally {
      offSubagentDone();
      const reason: 'clean' | 'aborted' = controller.signal.aborted ? 'aborted' : 'clean';
      await a.ctx.session
        .clearInFlightMarker(reason)
        .catch((err) => {
          a.logger.debug?.(
            `in-flight marker clear failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }
  }

  return { runInner };
}
