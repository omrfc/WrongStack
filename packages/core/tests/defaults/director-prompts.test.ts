import { describe, it, expect } from 'vitest';
import {
  composeDirectorPrompt,
  composeSubagentPrompt,
  rosterSummaryFromConfigs,
  DEFAULT_DIRECTOR_PREAMBLE,
  DEFAULT_SUBAGENT_BASELINE,
} from '../../src/defaults/director-prompts.js';
import { Director } from '../../src/defaults/director.js';
import type { MultiAgentConfig, SubagentConfig } from '../../src/types/multi-agent.js';

const baseConfig: MultiAgentConfig = {
  coordinatorId: 'test-director',
  doneCondition: { type: 'all_tasks_done' },
};

describe('composeDirectorPrompt', () => {
  it('uses the built-in preamble by default', () => {
    const out = composeDirectorPrompt();
    expect(out).toBe(DEFAULT_DIRECTOR_PREAMBLE.trim());
  });

  it('appends the user base prompt after the preamble', () => {
    const out = composeDirectorPrompt({ basePrompt: 'You manage refactors.' });
    expect(out.startsWith(DEFAULT_DIRECTOR_PREAMBLE.trim())).toBe(true);
    expect(out.endsWith('You manage refactors.')).toBe(true);
    expect(out).toContain('\n\nYou manage refactors.');
  });

  it('inserts a roster summary between preamble and base prompt', () => {
    const out = composeDirectorPrompt({
      basePrompt: 'BASE',
      rosterSummary: '- coder: Coder',
    });
    const preambleIdx = out.indexOf('You are the Director');
    const rosterIdx = out.indexOf('Available roles you can spawn');
    const baseIdx = out.indexOf('BASE');
    expect(preambleIdx).toBeLessThan(rosterIdx);
    expect(rosterIdx).toBeLessThan(baseIdx);
  });

  it('honors empty preamble override (suppresses fleet protocol block)', () => {
    const out = composeDirectorPrompt({
      directorPreamble: '',
      basePrompt: 'Only this.',
    });
    expect(out).toBe('Only this.');
    expect(out).not.toContain('You are the Director');
  });

  it('honors a custom preamble', () => {
    const out = composeDirectorPrompt({
      directorPreamble: 'CUSTOM PREAMBLE',
      basePrompt: 'BASE',
    });
    expect(out).toBe('CUSTOM PREAMBLE\n\nBASE');
  });

  it('skips empty sections (no stray blank lines)', () => {
    const out = composeDirectorPrompt({
      directorPreamble: 'A',
      basePrompt: '   ',
      rosterSummary: '',
    });
    expect(out).toBe('A');
    expect(out).not.toMatch(/\n\n\n/);
  });
});

describe('composeSubagentPrompt', () => {
  it('uses the built-in baseline by default', () => {
    const out = composeSubagentPrompt();
    expect(out).toBe(DEFAULT_SUBAGENT_BASELINE.trim());
  });

  it('layers baseline → role → task → override in that order', () => {
    const out = composeSubagentPrompt({
      role: 'You are a code reviewer.',
      task: 'Review src/foo.ts',
      override: 'Respond only in JSON.',
    });
    const baselineIdx = out.indexOf('You are a subagent');
    const roleIdx = out.indexOf('Role:');
    const taskIdx = out.indexOf('Task:');
    const overrideIdx = out.indexOf('Respond only in JSON');
    expect(baselineIdx).toBeGreaterThanOrEqual(0);
    expect(baselineIdx).toBeLessThan(roleIdx);
    expect(roleIdx).toBeLessThan(taskIdx);
    expect(taskIdx).toBeLessThan(overrideIdx);
  });

  it('per-spawn override is the last layer (wins on conflict)', () => {
    const out = composeSubagentPrompt({
      baseline: 'BASELINE',
      role: 'ROLE',
      override: 'OVERRIDE',
    });
    expect(out.lastIndexOf('OVERRIDE')).toBeGreaterThan(out.lastIndexOf('ROLE'));
    expect(out.lastIndexOf('OVERRIDE')).toBeGreaterThan(out.lastIndexOf('BASELINE'));
  });

  it('empty baseline override suppresses the bridge-contract block', () => {
    const out = composeSubagentPrompt({
      baseline: '',
      role: 'r',
      override: 'o',
    });
    expect(out).not.toContain('Bridge contract');
    expect(out).not.toContain('You are a subagent');
  });

  it('drops empty role/task/override entirely (no header-only blocks)', () => {
    const out = composeSubagentPrompt({
      baseline: 'X',
      role: '   ',
      task: '',
    });
    expect(out).toBe('X');
    expect(out).not.toContain('Role:');
    expect(out).not.toContain('Task:');
  });

  it('does NOT leak parent system prompt or tool list (regression test)', () => {
    // The baseline forbids subagents from requesting parent context. This
    // test pins that down — a future edit that accidentally adds parent
    // prompt material to the baseline would break it.
    const out = composeSubagentPrompt();
    expect(out).toMatch(/MAY NOT request the parent's system prompt/);
    expect(out).toMatch(/tool list/);
  });
});

describe('rosterSummaryFromConfigs', () => {
  it('renders one bullet per role with provider/model + headline', () => {
    const out = rosterSummaryFromConfigs({
      researcher: {
        name: 'Researcher',
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        prompt: 'You research things.',
      },
      coder: {
        name: 'Coder',
        provider: 'openai',
        model: 'gpt-5',
        prompt: 'You write code.\nMore details.',
      },
    });
    expect(out).toBe(
      [
        '- researcher: Researcher (anthropic/claude-haiku-4-5-20251001) — You research things.',
        '- coder: Coder (openai/gpt-5) — You write code.',
      ].join('\n'),
    );
  });

  it('omits provider/model tag when not configured', () => {
    const out = rosterSummaryFromConfigs({
      thing: { name: 'Thing', prompt: 'Do thing.' },
    });
    expect(out).toBe('- thing: Thing — Do thing.');
  });

  it('omits the headline when role has no prompt', () => {
    const out = rosterSummaryFromConfigs({
      bare: { name: 'Bare' },
    });
    expect(out).toBe('- bare: Bare');
  });

  it('truncates long headlines to 80 chars', () => {
    const long = 'a'.repeat(120);
    const out = rosterSummaryFromConfigs({
      r: { name: 'R', prompt: long },
    });
    const headlinePart = out.split(' — ')[1]!;
    expect(headlinePart.length).toBe(80);
  });
});

describe('Director.leaderSystemPrompt / subagentSystemPrompt', () => {
  it('leaderSystemPrompt composes preamble + base by default', () => {
    const director = new Director({
      config: {
        ...baseConfig,
        leaderSystemPrompt: 'BASE LEADER PROMPT',
      },
    });
    const out = director.leaderSystemPrompt();
    expect(out).toContain('You are the Director');
    expect(out).toContain('BASE LEADER PROMPT');
  });

  it('leaderSystemPrompt accepts an explicit base override', () => {
    const director = new Director({
      config: { ...baseConfig, leaderSystemPrompt: 'IGNORED' },
    });
    const out = director.leaderSystemPrompt('EXPLICIT');
    expect(out).toContain('EXPLICIT');
    expect(out).not.toContain('IGNORED');
  });

  it('leaderSystemPrompt includes roster summary when roster is provided', () => {
    const director = new Director({
      config: baseConfig,
      roster: {
        coder: { name: 'Coder', provider: 'openai', model: 'gpt-5', prompt: 'Codes things.' },
      },
    });
    const out = director.leaderSystemPrompt();
    expect(out).toContain('Available roles you can spawn');
    expect(out).toContain('- coder: Coder (openai/gpt-5) — Codes things.');
  });

  it('directorPreamble option overrides the built-in preamble', () => {
    const director = new Director({
      config: baseConfig,
      directorPreamble: 'MY CUSTOM PREAMBLE',
    });
    const out = director.leaderSystemPrompt('B');
    expect(out).toContain('MY CUSTOM PREAMBLE');
    expect(out).not.toContain('You are the Director');
  });

  it('subagentSystemPrompt composes baseline + role + override', () => {
    const director = new Director({ config: baseConfig });
    const cfg: SubagentConfig = {
      name: 'reviewer',
      prompt: 'You review code.',
      systemPromptOverride: 'Respond only in JSON.',
    };
    const out = director.subagentSystemPrompt(cfg, 'Review src/foo.ts');
    expect(out).toContain('You are a subagent');
    expect(out).toContain('Role:\nYou review code.');
    expect(out).toContain('Task:\nReview src/foo.ts');
    expect(out).toContain('Respond only in JSON.');
    expect(out.lastIndexOf('Respond only in JSON')).toBeGreaterThan(
      out.lastIndexOf('Role:'),
    );
  });

  it('subagentBaseline option overrides the bridge-contract baseline', () => {
    const director = new Director({
      config: baseConfig,
      subagentBaseline: 'CUSTOM BASELINE',
    });
    const out = director.subagentSystemPrompt({ name: 'x', prompt: 'r' });
    expect(out).toContain('CUSTOM BASELINE');
    expect(out).not.toContain('You are a subagent');
  });

  it('omitting taskBrief drops the Task section', () => {
    const director = new Director({ config: baseConfig });
    const out = director.subagentSystemPrompt({ name: 'x', prompt: 'r' });
    expect(out).not.toContain('Task:');
    expect(out).toContain('Role:\nr');
  });
});
