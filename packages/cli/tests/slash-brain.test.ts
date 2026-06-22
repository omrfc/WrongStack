import type { BrainArbiter, BrainDecisionRequest } from '@wrongstack/core';
import { describe, expect, it, vi } from 'vitest';
import { buildBrainCommand } from '../src/slash-commands/brain.js';
import type { SlashCommandContext } from '../src/slash-commands/index.js';

// Strip ANSI escapes so message assertions match regardless of color.
const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, '');

const makeCtx = (overrides: Partial<SlashCommandContext> = {}): SlashCommandContext => {
  const write = vi.fn();
  const writeWarning = vi.fn();
  return {
    renderer: { write, writeWarning } as never as SlashCommandContext['renderer'],
    ...overrides,
  } as never as SlashCommandContext;
};

describe('/brain slash command', () => {
  it('reports name, category and help text', () => {
    const cmd = buildBrainCommand(makeCtx());
    expect(cmd.name).toBe('brain');
    expect(cmd.category).toBe('Agent');
    expect(cmd.help).toContain('/brain risk');
    expect(cmd.help).toContain('/brain ask');
  });

  describe('status', () => {
    it('shows the current ceiling and an empty-log hint', async () => {
      const ctx = makeCtx({
        brainSettings: { maxAutoRisk: 'medium' },
        getBrainLog: () => [],
      });
      const result = await buildBrainCommand(ctx).run!('');
      const message = stripAnsi(result!.message!);
      expect(message).toContain('autonomy ceiling: medium');
      expect(message).toContain('no decisions recorded');
    });

    it('lists recent decisions newest-last', async () => {
      const now = Date.now();
      const ctx = makeCtx({
        brainSettings: { maxAutoRisk: 'high' },
        getBrainLog: () => [
          { at: now - 5_000, kind: 'answered', question: 'Continue phase 2?', outcome: 'continue' },
          {
            at: now - 1_000,
            kind: 'intervention',
            question: 'Tool edit failing',
            outcome: 'steered the agent',
          },
        ],
      });
      const result = await buildBrainCommand(ctx).run!('status');
      const message = stripAnsi(result!.message!);
      expect(message).toContain('recent decisions (2)');
      expect(message).toContain('Continue phase 2?');
      expect(message).toContain('steered the agent');
    });
  });

  describe('risk', () => {
    it('shows the current ceiling when no level is given', async () => {
      const ctx = makeCtx({ brainSettings: { maxAutoRisk: 'low' } });
      const result = await buildBrainCommand(ctx).run!('risk');
      expect(stripAnsi(result!.message!)).toContain('Brain autonomy ceiling: low');
    });

    it.each([
      'off',
      'low',
      'medium',
      'high',
      'all',
    ] as const)('sets the ceiling to %s in place', async (level) => {
      const settings = { maxAutoRisk: 'medium' as const } as { maxAutoRisk: string };
      const ctx = makeCtx({
        brainSettings: settings as SlashCommandContext['brainSettings'],
      });
      const result = await buildBrainCommand(ctx).run!(`risk ${level}`);
      expect(settings.maxAutoRisk).toBe(level);
      expect(stripAnsi(result!.message!)).toContain(`set to ${level}`);
    });

    it('rejects unknown levels without mutating settings', async () => {
      const settings = { maxAutoRisk: 'medium' as const };
      const ctx = makeCtx({ brainSettings: settings });
      const result = await buildBrainCommand(ctx).run!('risk extreme');
      expect(settings.maxAutoRisk).toBe('medium');
      expect(result?.message).toMatch(/Unknown risk level/);
      expect(ctx.renderer.writeWarning).toHaveBeenCalled();
    });

    it('warns when brainSettings is not wired', async () => {
      const ctx = makeCtx();
      const result = await buildBrainCommand(ctx).run!('risk high');
      expect(result?.message).toMatch(/not available/);
    });
  });

  describe('ask', () => {
    it('consults the brain and returns its answer', async () => {
      const decide = vi.fn(async () => ({
        type: 'answer' as const,
        text: 'Ship it.',
        rationale: 'Tests pass and scope is small.',
      }));
      const ctx = makeCtx({ brain: { decide } as BrainArbiter });
      const result = await buildBrainCommand(ctx).run!('ask should we ship?');
      const message = stripAnsi(result!.message!);
      expect(message).toContain('Ship it.');
      expect(message).toContain('Tests pass and scope is small.');
      const request = decide.mock.calls[0]?.[0] as BrainDecisionRequest;
      expect(request.source).toBe('user');
      expect(request.question).toBe('should we ship?');
      expect(request.fallback).toBe('ask_human');
    });

    it('surfaces denials', async () => {
      const ctx = makeCtx({
        brain: {
          decide: async () => ({ type: 'deny' as const, reason: 'risk too high' }),
        } as BrainArbiter,
      });
      const result = await buildBrainCommand(ctx).run!('ask delete prod db?');
      expect(stripAnsi(result!.message!)).toContain('Denied: risk too high');
    });

    it('explains when the brain escalates back to the human', async () => {
      const ctx = makeCtx({
        brain: {
          decide: async () => ({ type: 'ask_human' as const, prompt: 'You decide.' }),
        } as BrainArbiter,
      });
      const result = await buildBrainCommand(ctx).run!('ask migrate the schema?');
      expect(stripAnsi(result!.message!)).toContain('escalated this question back to you');
    });

    it('requires a question', async () => {
      const ctx = makeCtx({ brain: { decide: vi.fn() } as never as BrainArbiter });
      const result = await buildBrainCommand(ctx).run!('ask');
      expect(result?.message).toMatch(/Usage/);
    });

    it('warns when the brain is not wired', async () => {
      const ctx = makeCtx();
      const result = await buildBrainCommand(ctx).run!('ask anything');
      expect(result?.message).toMatch(/not available/);
    });

    it('reports consultation failures instead of throwing', async () => {
      const ctx = makeCtx({
        brain: {
          decide: async () => {
            throw new Error('provider offline');
          },
        } as BrainArbiter,
      });
      const result = await buildBrainCommand(ctx).run!('ask anything');
      expect(result?.message).toContain('provider offline');
    });
  });

  it('rejects unknown subcommands', async () => {
    const ctx = makeCtx();
    const result = await buildBrainCommand(ctx).run!('frobnicate');
    expect(result?.message).toMatch(/Unknown subcommand/);
  });
});
