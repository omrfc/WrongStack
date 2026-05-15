import type { MemoryStore } from '@wrongstack/core';
import { describe, expect, it, vi } from 'vitest';
import { forgetTool, rememberTool } from '../src/memory.js';
import { mkSandbox, newSignal } from './fixtures.js';

function fakeStore() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const store: MemoryStore = {
    readAll: vi.fn(async () => ''),
    read: vi.fn(async () => ''),
    remember: vi.fn(async (text: string, scope?: string) => {
      calls.push({ method: 'remember', args: [text, scope] });
    }),
    forget: vi.fn(async (query: string, scope?: string) => {
      calls.push({ method: 'forget', args: [query, scope] });
      return 2;
    }),
    consolidate: vi.fn(async () => undefined),
  };
  return { store, calls };
}

describe('memory tools', () => {
  it('remember appends with default scope', async () => {
    const { store, calls } = fakeStore();
    const tool = rememberTool(store);
    const sb = await mkSandbox();
    try {
      const out = await tool.execute({ text: 'use pnpm' }, sb.ctx, { signal: newSignal() });
      expect(out.ok).toBe(true);
      expect(out.scope).toBe('project-memory');
      expect(calls).toEqual([{ method: 'remember', args: ['use pnpm', 'project-memory'] }]);
    } finally {
      await sb.cleanup();
    }
  });

  it('remember honors explicit scope', async () => {
    const { store, calls } = fakeStore();
    const tool = rememberTool(store);
    const sb = await mkSandbox();
    try {
      await tool.execute({ text: 'prefer biome', scope: 'user-memory' }, sb.ctx, {
        signal: newSignal(),
      });
      expect(calls[0]?.args[1]).toBe('user-memory');
    } finally {
      await sb.cleanup();
    }
  });

  it('forget reports number removed', async () => {
    const { store } = fakeStore();
    const tool = forgetTool(store);
    const sb = await mkSandbox();
    try {
      const out = await tool.execute({ query: 'pnpm' }, sb.ctx, { signal: newSignal() });
      expect(out.removed).toBe(2);
    } finally {
      await sb.cleanup();
    }
  });

  it('remember rejects empty text', async () => {
    const { store } = fakeStore();
    const tool = rememberTool(store);
    const sb = await mkSandbox();
    try {
      await expect(tool.execute({ text: '' }, sb.ctx, { signal: newSignal() })).rejects.toThrow();
    } finally {
      await sb.cleanup();
    }
  });
});
