import { describe, expect, it } from 'vitest';
import { isWorktreeMonitorCloseKey } from '../src/components/worktree-monitor.js';

describe('isWorktreeMonitorCloseKey', () => {
  it('accepts Esc as the terminal-safe close key', () => {
    expect(isWorktreeMonitorCloseKey('', { escape: true })).toBe(true);
  });

  it('keeps Ctrl+W as a legacy close alias', () => {
    expect(isWorktreeMonitorCloseKey('w', { ctrl: true })).toBe(true);
  });

  it('ignores plain w and unrelated ctrl chords', () => {
    expect(isWorktreeMonitorCloseKey('w', {})).toBe(false);
    expect(isWorktreeMonitorCloseKey('x', { ctrl: true })).toBe(false);
  });
});
