import { describe, expect, it, vi } from 'vitest';
import { createAutonomyBrain, formatDecisionSummary } from '../../src/execution/autonomy-brain.js';
import type { BrainDecision, BrainDecisionRequest } from '../../src/coordination/brain.js';
import type { Provider } from '../../src/types/provider.js';

const req = (over: Partial<BrainDecisionRequest> = {}): BrainDecisionRequest => ({
  id: 'r1',
  source: 'autophase',
  question: 'Should we continue?',
  risk: 'low',
  fallback: 'continue',
  ...over,
});

/** A fake provider whose complete() returns a content-block response. */
function fakeProvider(text: string): Provider {
  return {
    id: 'fake',
    capabilities: {},
    stream: vi.fn(),
    complete: vi.fn(async () => ({ content: [{ type: 'text', text }] })),
  } as unknown as Provider;
}

function throwingProvider(): Provider {
  return {
    id: 'fake',
    capabilities: {},
    stream: vi.fn(),
    complete: vi.fn(async () => {
      throw new Error('LLM down');
    }),
  } as unknown as Provider;
}

describe('createAutonomyBrain — risk gate', () => {
  it('auto-denies a request above the max risk and reports via onDecision', async () => {
    const onDecision = vi.fn();
    const brain = createAutonomyBrain({ provider: fakeProvider('x'), model: 'm', maxAutoRisk: 'low', onDecision });
    const decision = await brain.decide(req({ risk: 'high', question: 'Delete prod DB?' }));
    expect(decision.type).toBe('deny');
    expect(onDecision).toHaveBeenCalledWith(expect.stringContaining('DENIED'), decision, expect.any(Object));
  });

  it('treats an unknown risk as high (default level 2)', async () => {
    const brain = createAutonomyBrain({ provider: fakeProvider('x'), model: 'm', maxAutoRisk: 'low' });
    const decision = await brain.decide(req({ risk: 'bogus' as never, question: 'weird' }));
    expect(decision.type).toBe('deny');
  });
});

describe('createAutonomyBrain — heuristics (quickDecide)', () => {
  it('skips deadlocked tasks blocked by failed dependencies', async () => {
    const brain = createAutonomyBrain({ provider: fakeProvider('x'), model: 'm' });
    const d = await brain.decide(req({ question: 'deadlock detected', context: 'tasks failed' }));
    expect(d).toMatchObject({ type: 'answer' });
    if (d.type === 'answer') expect(d.text).toContain('Skip deadlocked');
  });

  it('moves on when retries are exhausted', async () => {
    const brain = createAutonomyBrain({ provider: fakeProvider('x'), model: 'm' });
    const d = await brain.decide(req({ question: 'task failed again', context: 'retries exhausted' }));
    if (d.type === 'answer') expect(d.text).toContain('Mark as failed');
  });

  it('answers yes to a plain continue/proceed question without calling the LLM', async () => {
    const provider = fakeProvider('should not be called');
    const brain = createAutonomyBrain({ provider, model: 'm' });
    const d = await brain.decide(req({ question: 'Continue with phase 3?' }));
    expect(d).toMatchObject({ type: 'answer' });
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('routes goal-completion questions to the LLM (heuristic returns null)', async () => {
    const provider = fakeProvider('Continue execution. Progress is steady.');
    const brain = createAutonomyBrain({ provider, model: 'm' });
    const d = await brain.decide(req({ question: 'Is the goal complete?', risk: 'medium' }));
    expect(provider.complete).toHaveBeenCalled();
    expect(d).toMatchObject({ type: 'answer' });
  });
});

describe('createAutonomyBrain — LLM evaluation (llmDecide)', () => {
  it('matches a provided option id from the LLM text', async () => {
    const provider = fakeProvider('I choose [resolve] — safe to auto-resolve.');
    const brain = createAutonomyBrain({ provider, model: 'm' });
    const d = await brain.decide(
      req({
        question: 'mission complete?',
        options: [
          { id: 'resolve', label: 'Resolve conflict' },
          { id: 'stop', label: 'Stop' },
        ],
      }),
    );
    expect(d).toMatchObject({ type: 'answer', optionId: 'resolve', text: 'Resolve conflict' });
  });

  it('returns a free-text answer when no option matches', async () => {
    const provider = fakeProvider('Continue, progress looks good.');
    const brain = createAutonomyBrain({ provider, model: 'm' });
    const d = await brain.decide(req({ question: 'goal complete check', risk: 'medium' }));
    if (d.type === 'answer') expect(d.text).toContain('Continue');
  });

  it('falls back to a continue answer when the LLM returns empty text', async () => {
    const provider = fakeProvider('   ');
    const brain = createAutonomyBrain({ provider, model: 'm' });
    const d = await brain.decide(req({ question: 'goal complete?', fallback: 'continue' }));
    expect(d).toMatchObject({ type: 'answer', text: 'Continue execution.' });
  });

  it('falls back to denial text when the LLM returns empty and fallback is not continue', async () => {
    const provider = fakeProvider('');
    const brain = createAutonomyBrain({ provider, model: 'm' });
    const d = await brain.decide(req({ question: 'mission complete?', fallback: 'deny' }));
    if (d.type === 'answer') expect(d.text).toContain('Denied by autonomy policy');
  });

  it('uses the continue fallback when the provider throws', async () => {
    const brain = createAutonomyBrain({ provider: throwingProvider(), model: 'm' });
    const d = await brain.decide(req({ question: 'goal complete?', fallback: 'continue' }));
    expect(d).toMatchObject({ type: 'answer' });
    if (d.type === 'answer') expect(d.text).toContain('fallback');
  });

  it('denies when the provider throws and fallback is not continue', async () => {
    const brain = createAutonomyBrain({ provider: throwingProvider(), model: 'm' });
    const d = await brain.decide(req({ question: 'mission complete?', fallback: 'deny' }));
    expect(d).toMatchObject({ type: 'deny' });
  });

  it('falls through to the LLM for a question matching no heuristic pattern', async () => {
    const provider = fakeProvider('Resolve it.');
    const brain = createAutonomyBrain({ provider, model: 'm' });
    const d = await brain.decide(req({ question: 'How should we handle the merge conflict?', risk: 'medium' }));
    expect(provider.complete).toHaveBeenCalled(); // quickDecide returned null → LLM
    expect(d).toMatchObject({ type: 'answer' });
  });

  it('reads a bare {text} response shape', async () => {
    const provider = {
      id: 'fake',
      capabilities: {},
      stream: vi.fn(),
      complete: vi.fn(async () => ({ text: 'Continue from the text field.' })),
    } as unknown as Provider;
    const brain = createAutonomyBrain({ provider, model: 'm' });
    const d = await brain.decide(req({ question: 'goal complete?', risk: 'medium' }));
    if (d.type === 'answer') expect(d.text).toContain('text field');
  });

  it('handles a non-object provider response (extractText guard)', async () => {
    const provider = {
      id: 'fake',
      capabilities: {},
      stream: vi.fn(),
      complete: vi.fn(async () => null),
    } as unknown as Provider;
    const brain = createAutonomyBrain({ provider, model: 'm' });
    const d = await brain.decide(req({ question: 'goal complete?', fallback: 'continue' }));
    // empty extracted text → continue fallback
    expect(d).toMatchObject({ type: 'answer', text: 'Continue execution.' });
  });

  it('reads a choices-style (OpenAI) response shape and renders option consequences/recommended', async () => {
    const provider = {
      id: 'fake',
      capabilities: {},
      stream: vi.fn(),
      complete: vi.fn(async () => ({ choices: [{ message: { content: 'go with [a]' } }] })),
    } as unknown as Provider;
    const brain = createAutonomyBrain({ provider, model: 'm' });
    const d = await brain.decide(
      req({
        question: 'goal complete?',
        options: [
          { id: 'a', label: 'Option A', consequence: 'safe', recommended: true },
          { id: 'b', label: 'Option B' },
        ],
      }),
    );
    expect(d).toMatchObject({ type: 'answer', optionId: 'a' });
  });
});

describe('formatDecisionSummary', () => {
  it('formats a denial', () => {
    const d: BrainDecision = { type: 'deny', reason: 'too risky' };
    expect(formatDecisionSummary(d, req())).toContain('DENIED');
  });

  it('formats an option-id answer, a long-text answer, and a short-text answer', () => {
    expect(formatDecisionSummary({ type: 'answer', optionId: 'x', text: 'X' }, req())).toContain('chose [x]');
    const long = 'y'.repeat(100);
    expect(formatDecisionSummary({ type: 'answer', text: long }, req())).toContain('…');
    expect(formatDecisionSummary({ type: 'answer', text: 'short' }, req())).toContain('short');
  });

  it('formats an ask_human decision and truncates a long question', () => {
    const longQ = 'Q'.repeat(100);
    const out = formatDecisionSummary({ type: 'ask_human', prompt: 'p' }, req({ question: longQ }));
    expect(out).toContain('ASKED HUMAN');
    expect(out).toContain('…');
  });
});
