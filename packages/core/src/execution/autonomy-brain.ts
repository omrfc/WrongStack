/**
 * AutonomyBrain — a self-driving decision layer for autonomous workflows.
 *
 * Unlike the standard BrainArbiter which asks the human when uncertain,
 * AutonomyBrain makes decisions autonomously within configured risk
 * boundaries, keeping the system running unattended. It uses the session
 * LLM to evaluate situations and produce decisions.
 *
 * ## Identity
 * The AutonomyBrain is NOT the main agent. It is a dedicated decision
 * engine with a single purpose: evaluate blocked/stuck situations in
 * autonomous workflows and decide whether to continue, pivot, or stop.
 *
 * ## Decision Flow
 * 1. RISK GATE — if request risk > maxAutoRisk, auto-deny
 * 2. HEURISTIC — fast pattern-match for common situations (deadlock, retry-exhausted)
 * 3. LLM EVALUATION — complex decisions (goal completion, conflict resolution)
 *
 * ## Decision Logging
 * Every decision is emitted via `onDecision` callback with a human-readable
 * summary suitable for chat history and journal entries.
 *
 * Usage:
 *   const brain = createAutonomyBrain({
 *     provider, model, maxAutoRisk: 'high',
 *     onDecision: (summary) => journal.push(summary),
 *   });
 */

import type { Provider } from '../types/provider.js';
import type { BrainArbiter, BrainDecision, BrainDecisionRequest } from '../coordination/brain.js';

export interface AutonomyBrainOptions {
  /** LLM provider for decision-making. */
  provider: Provider;
  /** Model to use for decisions (should be fast + cheap). */
  model: string;
  /** Maximum risk level the brain will auto-decide. Default: 'high'.
   *  'low'    — only auto-decide low-risk questions
   *  'medium' — auto-decide low/medium
   *  'high'   — auto-decide low/medium/high
   *  'all'    — auto-decide everything (including critical)
   */
  maxAutoRisk?: 'low' | 'medium' | 'high' | 'all' | undefined;
  /** Timeout for each decision call (ms). Default: 15_000. */
  decisionTimeoutMs?: number | undefined;
  /**
   * Called after every decision with a human-readable summary.
   * Use this to log decisions into chat history, journal, or status line.
   * Example: "🧠 Brain: skipped deadlocked tasks → continuing with phase 3/5"
   */
  onDecision?: ((summary: string, decision: BrainDecision, request: BrainDecisionRequest) => void) | undefined;
}

const RISK_LEVELS: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * Create a self-driving brain that makes autonomous decisions.
 * Never asks the human — within its risk boundary it answers, above it denies.
 */
export function createAutonomyBrain(opts: AutonomyBrainOptions): BrainArbiter {
  const maxRisk = opts.maxAutoRisk ?? 'high';
  const maxRiskLevel = RISK_LEVELS[maxRisk] ?? 2;
  const timeoutMs = opts.decisionTimeoutMs ?? 15_000;

  return {
    async decide(request: BrainDecisionRequest): Promise<BrainDecision> {
      const requestLevel = RISK_LEVELS[request.risk] ?? 2;

      // RISK GATE — above our risk boundary → auto-deny
      if (requestLevel > maxRiskLevel) {
        const reason = `Auto-denied: risk "${request.risk}" exceeds max "${maxRisk}"`;
        const decision: BrainDecision = { type: 'deny', reason };
        opts.onDecision?.(
          `🧠 Brain: DENIED — ${request.question.slice(0, 80)} (risk: ${request.risk} > ${maxRisk})`,
          decision,
          request,
        );
        return decision;
      }

      // HEURISTIC — fast pattern-match
      const heuristic = quickDecide(request);
      if (heuristic) {
        opts.onDecision?.(formatDecisionSummary(heuristic, request), heuristic, request);
        return heuristic;
      }

      // LLM EVALUATION — complex decisions
      const llmDecision = await llmDecide(request, opts.provider, opts.model, timeoutMs);
      opts.onDecision?.(formatDecisionSummary(llmDecision, request), llmDecision, request);
      return llmDecision;
    },
  };
}

/**
 * Format a decision as a human-readable one-liner for chat history.
 */
export function formatDecisionSummary(
  decision: BrainDecision,
  request: BrainDecisionRequest,
): string {
  const question = request.question.length > 80
    ? request.question.slice(0, 77) + '…'
    : request.question;

  if (decision.type === 'deny') {
    return `🧠 Brain: DENIED — "${question}" → ${decision.reason}`;
  }

  if (decision.type === 'answer') {
    const action = decision.optionId
      ? `chose [${decision.optionId}]`
      : decision.text.length > 60
        ? decision.text.slice(0, 57) + '…'
        : decision.text;
    return `🧠 Brain: DECIDED — "${question}" → ${action}`;
  }

  return `🧠 Brain: ASKED HUMAN — "${question}"`;
}

/** Fast heuristic decisions that don't need an LLM call. */
function quickDecide(request: BrainDecisionRequest): BrainDecision | null {
  const q = request.question.toLowerCase();
  const ctx = request.context?.toLowerCase() ?? '';

  // Deadlock with failed tasks → skip and continue
  if (q.includes('deadlock') && ctx.includes('failed')) {
    return {
      type: 'answer',
      text: 'Skip deadlocked tasks and continue with remaining work. Failed tasks will be reported in the final summary.',
      rationale: 'Heuristic: deadlocked tasks blocked by failed dependencies — skipping unblocks remaining work.',
    };
  }

  // Repeated failure with exhausted retries → move on
  if (
    (q.includes('failed') || q.includes('retry')) &&
    (ctx.includes('3') || ctx.includes('exhausted'))
  ) {
    return {
      type: 'answer',
      text: 'Mark as failed and move on. Note the failure for the final report.',
      rationale: 'Heuristic: retries exhausted — continuing would waste resources.',
    };
  }

  // Goal complete verification → needs LLM evaluation
  if (q.includes('goal complete') || q.includes('mission complete')) {
    return null;
  }

  // Continue/proceed → always yes
  if (q.includes('continue') || q.includes('proceed')) {
    return {
      type: 'answer',
      text: 'Continue execution. Do not stop.',
      rationale: 'Heuristic: autonomy mode — continue until all work is complete.',
    };
  }

  return null;
}

/**
 * Ask the LLM for a decision on complex questions.
 * Uses a carefully crafted system prompt that establishes the brain's
 * identity, purpose, and decision-making framework.
 */
async function llmDecide(
  request: BrainDecisionRequest,
  provider: Provider,
  model: string,
  timeoutMs: number,
): Promise<BrainDecision> {
  const optionsText = request.options?.length
    ? '\nOptions:\n' +
      request.options
        .map(
          (o) =>
            `  [${o.id}] ${o.label}${o.consequence ? ` — ${o.consequence}` : ''}${o.recommended ? ' ★ recommended' : ''}`,
        )
        .join('\n')
    : '';

  const systemPrompt = [
    'IDENTITY:',
    'You are the Autonomy Brain — a dedicated decision engine inside an',
    'autonomous AI coding agent called WrongStack. Your SOLE purpose is to',
    'evaluate situations where the autonomous workflow is blocked, stuck, or',
    'uncertain, and decide the best course of action to keep the system',
    'running and making progress toward its goal.',
    '',
    'WHAT YOU DO:',
    '- You receive a question + context from an autonomy subsystem (goal',
    '  engine, phase orchestrator, task decomposer).',
    '- You evaluate whether the system should continue, pivot, retry, skip,',
    '  or stop.',
    '- You output exactly ONE decision. No preamble, no markdown, no',
    '  elaboration beyond what is needed to justify the decision.',
    '',
    'HOW YOU DECIDE:',
    '1. PREFER CONTINUATION. The default answer is always "continue" unless',
    '   there is clear evidence that stopping is safer or more productive.',
    '2. BE SPECIFIC. If options are provided, pick one by its [id]. If not,',
    '   describe the exact action in 1-2 sentences.',
    '3. VERIFY COMPLETION. If the question is about whether the goal is done,',
    '   check deliverables and progress before saying yes. A progress bar at',
    '   80% with open deliverables means NOT done.',
    '4. AVOID WASTE. If a task has failed 3+ times with the same approach,',
    '   recommend a different approach or skipping it — do not recommend',
    '   retrying the same thing.',
    '5. CONSIDER COST. If the question mentions spent budget or token counts,',
    '   factor that into your decision. A goal that has already spent $50',
    '   with 90% progress is worth finishing; one at 15% with $100 spent',
    '   may need re-evaluation.',
    '',
    'OUTPUT FORMAT:',
    '- With options: output the option [id] and a 1-sentence justification.',
    '  Example: "[resolve] — conflict is in test files only, safe to auto-resolve."',
    '- Without options: output the decision as a 1-2 sentence action.',
    '  Example: "Continue execution. Progress is steady at 60% with 3/5',
    '  deliverables done. No reason to stop."',
    '',
    'CRITICAL RULE:',
    'You are NOT the main agent. Do not suggest code changes, tool calls,',
    'or implementation details. Your output is a DECISION, not a plan.',
  ].join('\n');

  const userMessage = [
    `Question: ${request.question}`,
    request.context ? `\nContext:\n${request.context}` : '',
    optionsText,
  ].filter(Boolean).join('\n');

  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await provider.complete(
      {
        model,
        system: [{ type: 'text', text: systemPrompt }],
        messages: [{ role: 'user', content: userMessage || 'Decide.' }],
        maxTokens: 200,
      },
      { signal },
    );

    const text = extractText(response).trim();

    // Try to match an option id
    if (request.options?.length) {
      for (const opt of request.options) {
        if (text.toLowerCase().includes(opt.id.toLowerCase())) {
          return {
            type: 'answer',
            optionId: opt.id,
            text: opt.label,
            rationale: text,
          };
        }
      }
    }

    // Free-text answer
    return {
      type: 'answer',
      text: text || (request.fallback === 'continue'
        ? 'Continue execution.'
        : 'Denied by autonomy policy.'),
      rationale: text || undefined,
    };
  } catch {
    // LLM unavailable — use fallback
    if (request.fallback === 'continue') {
      return {
        type: 'answer',
        text: 'Continue (Autonomy Brain LLM unavailable — using fallback).',
      };
    }
    return { type: 'deny', reason: 'Autonomy Brain LLM unavailable for decision.' };
  }
}

function extractText(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.content)) {
    return (r.content as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  }
  if (Array.isArray(r.choices)) {
    return (r.choices as Array<{ message?: { content?: string } }>)[0]?.message?.content ?? '';
  }
  return typeof r.text === 'string' ? r.text : '';
}
