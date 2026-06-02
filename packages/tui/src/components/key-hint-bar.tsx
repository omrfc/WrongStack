import { Box, Text } from 'ink';
import type React from 'react';
import { theme } from '../theme.js';

/** Which interactive context is active — drives which shortcuts the bar shows.
 *  Ordered by priority (a confirm prompt overrides a picker, etc.). */
export interface KeyHintContext {
  confirm?: boolean;
  picker?: boolean; // file / slash / model / autonomy picker, or rewind overlay
  monitor?: boolean; // any full-screen monitor overlay open
  managed?: boolean; // managed viewport active (in-app scroll)
  mouse?: boolean; // full mouse mode on
}

export interface Hint {
  key: string;
  label: string;
}

export function hintsFor(ctx: KeyHintContext): Hint[] {
  if (ctx.confirm) {
    return [
      { key: 'y', label: 'yes' },
      { key: 'n', label: 'no' },
      { key: 'a', label: 'always' },
      { key: 'd', label: 'deny' },
    ];
  }
  if (ctx.picker) {
    return [
      { key: '↑↓', label: 'move' },
      { key: '↵', label: 'select' },
      { key: 'Esc', label: 'cancel' },
      ...(ctx.mouse ? [{ key: 'click', label: 'pick' }] : []),
    ];
  }
  if (ctx.monitor) {
    return [
      { key: 'Esc', label: 'close' },
      { key: '^F', label: 'fleet' },
      { key: '^G', label: 'agents' },
      { key: '^T', label: 'worktrees' },
    ];
  }
  // Idle / chat.
  const base: Hint[] = [{ key: '?', label: 'help' }];
  if (ctx.managed) base.push({ key: 'PgUp/PgDn', label: 'scroll' });
  if (ctx.mouse) base.push({ key: 'wheel', label: 'scroll' }, { key: 'click', label: 'select' });
  base.push({ key: '^G', label: 'agents' }, { key: '^C', label: 'stop' });
  return base;
}

/**
 * Persistent one-line keybinding hint bar shown at the very bottom of the TUI,
 * like a status-line cheat sheet. Context-aware: surfaces the keys that matter
 * for whatever is on screen (confirm prompt → y/n/a/d, picker → ↑↓/↵, etc.).
 */
export function KeyHintBar({ context }: { context: KeyHintContext }): React.ReactElement {
  const hints = hintsFor(context);
  return (
    <Box flexDirection="row" paddingX={1}>
      {hints.map((h, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: hints are positional + stable
        <Box key={i} flexDirection="row" marginRight={2}>
          <Text color={theme.accent}>{h.key}</Text>
          <Text dimColor>{` ${h.label}`}</Text>
        </Box>
      ))}
    </Box>
  );
}
