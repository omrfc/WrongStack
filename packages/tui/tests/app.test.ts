import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/app.js';
import type {
  Agent,
  AttachmentStore,
  EventBus,
  SlashCommandRegistry,
  TodoItem,
} from '@wrongstack/core';
import type { StatuslineItem } from '../src/components/statusline-picker.js';

// ── Stubs ─────────────────────────────────────────────────────────────
const NOOP = () => {};

function stubEventBus(): EventBus {
  return {
    emit: vi.fn(),
    emitCustom: vi.fn(),
    once: vi.fn(),
    on: vi.fn().mockReturnValue(NOOP),
    off: vi.fn(),
    removeAllListeners: vi.fn(),
  } as unknown as EventBus;
}

function stubSlashRegistry(): SlashCommandRegistry {
  return {
    commands: [],
    register: vi.fn(),
    unregister: vi.fn(),
    getCommand: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    getMatches: vi.fn().mockReturnValue([]),
    registerBuiltin: vi.fn(),
  } as unknown as SlashCommandRegistry;
}

function stubAttachmentStore(): AttachmentStore {
  return {
    attachments: [],
    add: vi.fn(),
    remove: vi.fn(),
    items: vi.fn().mockReturnValue([]),
    read: vi.fn(),
    clear: vi.fn(),
  } as unknown as AttachmentStore;
}

function stubAgent(): Agent {
  return {
    ctx: {
      todos: [] as TodoItem[],
      messages: [],
      projectRoot: '/test/project',
      model: 'anthropic/claude-sonnet-4',
      provider: {
        id: 'anthropic',
        capabilities: { maxContext: 200_000, supportsVision: true },
      },
      session: { id: 'test-session', writeEvent: vi.fn() },
      sideEffects: [],
      signal: new AbortController().signal,
      tokenCounter: {
        countTokens: vi.fn().mockReturnValue(0),
        estimateCost: vi.fn().mockReturnValue({ total: 0 }),
        total: vi.fn().mockReturnValue({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      },
      cwd: '/test/project',
      workingDir: '/test/project',
      systemPrompt: [],
      tools: [],
      agentId: 'test',
      agentName: 'Test Agent',
      writtenFiles: new Set(),
      recordRead: vi.fn(),
    },
    run: vi.fn().mockResolvedValue({ status: 'done', iterations: 0, finalText: '' }),
    abort: vi.fn(),
    on: vi.fn().mockReturnValue(NOOP),
  } as unknown as Agent;
}

// ── Props factory ─────────────────────────────────────────────────────
function freshProps() {
  return {
    agent: stubAgent(),
    slashRegistry: stubSlashRegistry(),
    attachments: stubAttachmentStore(),
    events: stubEventBus(),
    model: 'anthropic/claude-sonnet-4',
    onExit: vi.fn(),
    director: null,
    statuslineHiddenItems: [] as StatuslineItem[],
    setStatuslineHiddenItems: vi.fn(),
    saveStatuslineHiddenItems: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Test ──────────────────────────────────────────────────────────────
//
// PR 0 — Baseline integration test.
//
// Uses a single `it()` block because ink-testing-library v4 does not fully
// clean up Ink's global reconciler state across repeated render/cleanup
// cycles (subsequent renders within the same process trigger a RangeError
// from render-border.ts when Yoga computes zero dimensions in the mock
// terminal).  This does NOT affect real terminal usage.

describe('PR 0 — App baseline integration test', () => {
  it('mounts <App> with a stub Agent, captures console, unmounts cleanly', () => {
    const errors: Array<unknown[]> = [];
    const origErr = console.error;
    const origWarn = console.warn;
    console.error = (...args: unknown[]) => { errors.push(args); };
    console.warn = (...args: unknown[]) => { errors.push(args); };

    const { unmount, cleanup } = render(React.createElement(App, freshProps()));

    console.error = origErr;
    console.warn = origWarn;

    // 1. Mounts without console errors
    expect(errors.length).toBe(0);

    // 2. Unmount + cleanup does not throw
    expect(() => { unmount(); cleanup(); }).not.toThrow();
  });
});
