import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_CATALOG,
  ALL_AGENT_DEFINITIONS,
  DEFAULT_DISPATCH_ROLE,
  dispatchAgent,
  scoreAgents,
  makeLLMClassifier,
} from '../../src/coordination/index.js';

describe('catalog', () => {
  it('has 43 catalog agents, all with role/prompt/keywords', () => {
    const roles = Object.keys(AGENT_CATALOG);
    expect(roles.length).toBe(43);
    for (const def of Object.values(AGENT_CATALOG)) {
      expect(def.config.role).toBeTruthy();
      expect((def.config.prompt ?? '').length).toBeGreaterThan(50);
      expect(def.capability.keywords.length).toBeGreaterThan(0);
      expect(def.budget.timeoutMs).toBeGreaterThan(0);
    }
  });
});

describe('catalog routing health', () => {
  it('every agent is reachable: it tops the scoreboard for a task built from its own keywords', () => {
    const unreachable: Array<{ role: string; winner: string; targetScore: number; topScore: number }> = [];
    for (const def of ALL_AGENT_DEFINITIONS) {
      const role = def.config.role as string;
      // A task that contains exactly this agent's signal words. The agent
      // matches all of them, so no sibling should be able to strictly outscore
      // it on its own vocabulary — if one does, the agent is shadowed and can
      // never win even on a perfectly on-topic request.
      const task = def.capability.keywords.join(', ');
      const ranked = scoreAgents(task);
      const top = ranked[0];
      const mine = ranked.find((c) => c.role === role);
      if (!top || !mine || mine.score !== top.score) {
        unreachable.push({
          role,
          winner: top?.role ?? '(none)',
          targetScore: mine?.score ?? 0,
          topScore: top?.score ?? 0,
        });
      }
    }
    expect(unreachable, JSON.stringify(unreachable, null, 2)).toEqual([]);
  });

  it('no two agents share an identical keyword set (which would make routing order-dependent)', () => {
    const bySet = new Map<string, string[]>();
    for (const def of ALL_AGENT_DEFINITIONS) {
      const key = [...def.capability.keywords].map((k) => k.trim()).sort().join('|');
      const arr = bySet.get(key) ?? [];
      arr.push(def.config.role as string);
      bySet.set(key, arr);
    }
    const collisions = [...bySet.values()].filter((roles) => roles.length > 1);
    expect(collisions, JSON.stringify(collisions)).toEqual([]);
  });

  it('the fallback role exists in the catalog so dispatch can never resolve to an unknown agent', () => {
    expect(AGENT_CATALOG[DEFAULT_DISPATCH_ROLE]).toBeDefined();
  });
});

describe('scoreAgents', () => {
  it('ranks the obvious agent first for a clear task', () => {
    const ranked = scoreAgents('there is a bug, the app crashes on login, please debug it');
    expect(ranked[0]?.role).toBe('debugger');
  });

  it('matches multi-word phrases stronger than single words', () => {
    const ranked = scoreAgents('write end to end tests for the checkout journey');
    expect(ranked[0]?.role).toBe('e2e');
  });

  it('returns empty for a task with no signal', () => {
    expect(scoreAgents('zzzzz qqqqq wwwww')).toEqual([]);
  });
});

describe('dispatchAgent (heuristic)', () => {
  it('routes a security task to the security reviewer', async () => {
    const r = await dispatchAgent('review this code for sql injection vulnerabilities');
    expect(r.role).toBe('security-reviewer');
    expect(r.method).toBe('heuristic');
    expect(r.confidence).toBeGreaterThan(0);
  });

  it('falls back to executor when there is no signal and no classifier', async () => {
    const r = await dispatchAgent('zzzzz qqqqq wwwww');
    expect(r.role).toBe('executor');
    expect(r.method).toBe('fallback');
    expect(r.confidence).toBe(0);
  });
});

describe('dispatchAgent (LLM fallback)', () => {
  it('invokes the classifier on an ambiguous task and honors its choice', async () => {
    const classifier = vi.fn(async () => ({ role: 'architect', reason: 'design work' }));
    // A vague task that produces a weak/ambiguous heuristic signal.
    const r = await dispatchAgent('think about how to shape this thing', {
      classifier,
      confidenceThreshold: 0.99, // force the LLM path
    });
    expect(classifier).toHaveBeenCalledOnce();
    expect(r.role).toBe('architect');
    expect(r.method).toBe('llm');
  });

  it('ignores a classifier choice that is not in the catalog', async () => {
    const classifier = vi.fn(async () => ({ role: 'not-a-real-agent' }));
    const r = await dispatchAgent('zzzzz qqqqq wwwww', { classifier });
    // Invalid choice → fall through to fallback generalist.
    expect(r.role).toBe('executor');
    expect(r.method).toBe('fallback');
  });

  it('survives a throwing classifier', async () => {
    const classifier = vi.fn(async () => {
      throw new Error('provider down');
    });
    const r = await dispatchAgent('zzzzz qqqqq wwwww', { classifier });
    expect(r.role).toBe('executor');
  });
});

describe('makeLLMClassifier', () => {
  it('parses a clean JSON choice', async () => {
    const classify = makeLLMClassifier(async () => '{"role":"debugger","reason":"bug"}');
    const out = await classify('x', [{ role: 'debugger', name: 'Debugger', summary: 's' }]);
    expect(out).toEqual({ role: 'debugger', reason: 'bug' });
  });

  it('extracts JSON even with surrounding prose / fences', async () => {
    const classify = makeLLMClassifier(
      async () => 'Sure!\n```json\n{"role":"test"}\n```\nHope that helps.',
    );
    const out = await classify('x', [{ role: 'test', name: 'Test', summary: 's' }]);
    expect(out?.role).toBe('test');
  });

  it('returns null for an out-of-list role', async () => {
    const classify = makeLLMClassifier(async () => '{"role":"ghost"}');
    const out = await classify('x', [{ role: 'test', name: 'Test', summary: 's' }]);
    expect(out).toBeNull();
  });

  it('returns null for unparseable output', async () => {
    const classify = makeLLMClassifier(async () => 'no json here');
    const out = await classify('x', [{ role: 'test', name: 'Test', summary: 's' }]);
    expect(out).toBeNull();
  });
});
