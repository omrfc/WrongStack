import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { StatusBar, type StatusBarProps } from '../src/components/status-bar.js';

// Strip ANSI so we assert on the plain glyphs the user actually sees.
function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function frameOf(props: Partial<StatusBarProps>): string {
  const { lastFrame, unmount } = render(
    React.createElement(StatusBar, {
      model: 'anthropic/claude',
      state: 'idle',
      ...props,
    } as StatusBarProps),
  );
  const out = strip(lastFrame() ?? '');
  unmount();
  return out;
}

/**
 * Regression tests for the declarative `joinChips` separator refactor. The old
 * code recomputed "did any earlier chip render?" inline per chip by OR-ing every
 * preceding condition; those chains drifted and dropped separators in real
 * combinations. These tests pin the corrected behavior.
 */
describe('StatusBar chip separators', () => {
  it('line 2: separates the autonomy chip from the project chip when elapsed is hidden', () => {
    // OLD BUG: the project chip only drew a leading separator for `yolo ||
    // startedAt`, so with autonomy on, elapsed hidden, and no startedAt the
    // chips rendered mashed together ("∞ AUTO📁 proj").
    const frame = frameOf({
      autonomy: 'auto',
      projectName: 'proj',
      hiddenItems: ['elapsed'],
      startedAt: undefined,
    });
    expect(frame).toContain('∞ AUTO');
    expect(frame).toContain('📁 proj');
    expect(frame).toMatch(/AUTO\s*│\s*📁 proj/);
  });

  it('line 3: separates the task chip from the fleet chip without todos/plan present', () => {
    // OLD BUG: the fleet chip's leading separator only checked todos/plan, so a
    // tasks+fleet line with neither rendered "⚡ ☐1🌐 ▶1" with no separator.
    const frame = frameOf({
      tasks: { pending: 1, inProgress: 0, completed: 0, blocked: 0, failed: 0 },
      fleet: { running: 1, idle: 0, pending: 0, completed: 0 },
    });
    expect(frame).toMatch(/⚡[^│]*│[^│]*🌐/);
  });

  it('never emits a leading separator on line 3 (single visible chip)', () => {
    const frame = frameOf({
      todos: { pending: 2, inProgress: 1, completed: 0 },
    });
    // The todos chip is the only one on line 3 — there must be no stray │.
    const line = frame.split('\n').find((l) => l.includes('todos')) ?? '';
    expect(line).not.toContain('│');
  });

  it('inserts exactly one separator between every adjacent pair on line 2', () => {
    const frame = frameOf({
      yolo: true,
      autonomy: 'eternal',
      projectName: 'proj',
      hiddenItems: ['elapsed'],
      startedAt: undefined,
    });
    const line = frame.split('\n').find((l) => l.includes('YOLO')) ?? '';
    // 3 visible chips (YOLO, ∞ ETERNAL, 📁 proj) → exactly 2 separators.
    expect((line.match(/│/g) ?? []).length).toBe(2);
    expect(line).toMatch(/YOLO\s*│\s*∞ ETERNAL\s*│\s*📁 proj/);
  });

  it('hides mailbox line content when mailbox is disabled', () => {
    const frame = frameOf({
      mailbox: {
        unread: 2,
        onlineAgents: 3,
        onlineClients: { tui: 1, webui: 1, repl: 0 },
        lastSubject: 'handoff',
        lastFrom: 'worker',
      },
      hiddenItems: ['mailbox'],
    });

    expect(frame).not.toContain('✉');
    expect(frame).not.toContain('handoff');
  });

  it('does not render an idle mailbox chip for the current TUI alone', () => {
    const frame = frameOf({
      mailbox: {
        unread: 0,
        onlineAgents: 1,
        onlineClients: { tui: 1, webui: 0, repl: 0 },
      },
    });

    expect(frame).not.toContain('✉');
    expect(frame).not.toContain('👥');
  });

  it('renders mailbox when a peer surface is online even with no unread mail', () => {
    const frame = frameOf({
      mailbox: {
        unread: 0,
        onlineAgents: 1,
        onlineClients: { tui: 1, webui: 1, repl: 0 },
      },
    });

    expect(frame).toContain('✉ 0');
    expect(frame).toContain('🌐 WebUI');
  });
});
