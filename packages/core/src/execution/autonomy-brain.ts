/**
 * AutonomyBrain — a self-driving decision layer for autonomous workflows.
 *
 * Unlike the standard BrainArbiter which asks the human when uncertain,
 * AutonomyBrain makes decisions autonomously within configured risk
 * boundaries, keeping the system running unattended. It uses the session
 * LLM to evaluate situations and produce decisions.
 *
 * Usage:
 *   const brain = createAutonomyBrain({ provider, model, maxAutoRisk: 'high' });
 *   const decision = await brain.decide({ ... });
 *   // decision.type is always 'answer' or 'deny', never 'ask_human'
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

      // Above our risk boundary → auto-deny (safe default)
      if (requestLevel > maxRiskLevel) {
        return {
          type: 'deny',
          reason: `Auto-denied: risk "${request.risk}" exceeds max "${maxRisk}"`,
        };
      }

      // Quick heuristic decisions for simple cases (no LLM call needed)
      const heuristic = quickDecide(request);
      if (heuristic) return heuristic;

      // LLM-driven decision for complex cases
      return llmDecide(request, opts.provider, opts.model, timeoutMs);
    },
  };
}

/** Fast heuristic decisions that don't need an LLM call. */
function quickDecide(request: BrainDecisionRequest): BrainDecision | null {
  const q = request.question.toLowerCase();
  const ctx = request.context?.toLowerCase() ?? '';

  // Deadlock with failed tasks → skip and continue
  if (
    q.includes('deadlock') &&
    ctx.includes('failed')
  ) {
    return {
      type: 'answer',
      text: 'Skip deadlocked tasks and continue with remaining work. Failed tasks will be reported in the final summary.',
      rationale: 'Deadlocked tasks blocked by failed dependencies — skipping unblocks remaining work.',
    };
  }

  // Repeated failure → try different approach
  if (
    (q.includes('failed') || q.includes('retry')) &&
    (ctx.includes('3') || ctx.includes('exhausted'))
  ) {
    return {
      type: 'answer',
      text: 'Mark as failed and move on. Note the failure for the final report.',
      rationale: 'Retries exhausted — continuing would waste resources.',
    };
  }

  // Goal complete question → verify before accepting
  if (q.includes('goal complete') || q.includes('mission complete')) {
    // Don't auto-decide — let LLM evaluate
    return null;
  }

  // Continue running?
  if (q.includes('continue') || q.includes('proceed')) {
    return {
      type: 'answer',
      text: 'Continue execution. Do not stop.',
      rationale: 'Autonomy mode — continue until all phases complete.',
    };
  }

  return null;
}

/** Ask the LLM for a decision on complex questions. */
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
            `  [${o.id}] ${o.label}${o.consequence ? ` — ${o.consequence}` : ''}${o.recommended ? ' (recommended)' : ''}`,
        )
        .join('\n')
    : '';

  const prompt = [
    'You are an autonomy decision engine. Your job: evaluate the situation',
    'and pick the best course of action to keep the autonomous workflow',
    'running and making progress toward its goal.',
    '',
    'Rules:',
    '- Prefer actions that keep the system running over actions that stop it.',
    '- If a task is stuck, find a way around it rather than reporting failure.',
    '- If the goal appears complete, verify carefully before accepting.',
    '- Be specific — name the option id or describe the exact action.',
    '- Output ONE decision. No preamble, no markdown.',
    '',
    `Question: ${request.question}`,
    request.context ? `\nContext:\n${request.context}` : '',
    optionsText,
    '',
    'Decision (answer with option id or action description):',
  ].join('\n');

  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await provider.complete(
      {
        model,
        system: [{ type: 'text', text: prompt }],
        messages: [{ role: 'user', content: 'Decide.' }],
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
      text: text || request.fallback === 'continue'
        ? 'Continue execution.'
        : 'Denied by autonomy policy.',
      rationale: text || undefined,
    };
  } catch {
    // LLM unavailable — use fallback
    if (request.fallback === 'continue') {
      return { type: 'answer', text: 'Continue (LLM unavailable — fallback).' };
    }
    return { type: 'deny', reason: 'LLM unavailable for decision.' };
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
