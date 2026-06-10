import { Box, Text } from '../ink.js';
import type React from 'react';
import { theme } from '../theme.js';

export interface HelpEntry {
  /** Key chord or command, e.g. `Ctrl+F` or `/model`. */
  keys: string;
  /** What it does. */
  desc: string;
}

export interface HelpSection {
  title: string;
  entries: HelpEntry[];
}

/**
 * Static cheat-sheet content: keybindings + common slash commands, grouped by
 * area. Pure data (no JSX) so the exact set of entries is unit-testable and the
 * overlay renders identically everywhere.
 */
export function helpSections(): HelpSection[] {
  const nav: HelpEntry[] = [];
  nav.push(
    { keys: '↑/↓', desc: 'previous / next input (empty prompt)' },
    { keys: '?', desc: 'open this help (empty prompt)' },
  );

  return [
    { title: 'Navigation', entries: nav },
    {
      title: 'Monitors',
      entries: [
        { keys: 'F1', desc: 'project switcher (also /project)' },
        { keys: 'Ctrl+F / F2', desc: 'fleet orchestration monitor' },
        { keys: 'Ctrl+G / F3', desc: 'agents live monitor' },
        { keys: 'Ctrl+T / F4', desc: 'worktree monitor' },
        { keys: 'F5', desc: 'autonomy settings (also Ctrl+S)' },
        { keys: 'F6', desc: 'todos monitor overlay' },
        { keys: 'F7', desc: 'queue panel' },
        { keys: 'F8', desc: 'process list overlay' },
        { keys: 'F9', desc: 'goal panel' },
        { keys: 'F10', desc: 'live sessions panel' },
        { keys: 'Esc', desc: 'close the open monitor / overlay' },
      ],
    },
    {
      title: 'Editing',
      entries: [
        { keys: 'Enter', desc: 'send (queues while the agent is busy)' },
        { keys: 'Esc Esc', desc: 'clear the input buffer' },
        { keys: 'Ctrl+Backspace', desc: 'delete the previous word' },
        { keys: 'Ctrl+S', desc: 'edit autonomy settings' },
        { keys: 'Ctrl+C', desc: 'interrupt the run · twice to exit' },
      ],
    },
    {
      title: 'Commands',
      entries: [
        { keys: '/project', desc: 'switch projects (also F1)' },
        { keys: '/help', desc: 'list all slash commands' },
        { keys: '/model', desc: 'switch the active model' },
        { keys: '/fleet', desc: 'multi-agent fleet controls' },
        { keys: '/goal', desc: 'set an autonomous goal' },
        { keys: '/autonomy', desc: 'autonomy mode (eternal / off)' },
        { keys: '/settings', desc: 'autonomy defaults (also Ctrl+S)' },
        { keys: '/clear', desc: 'clear the conversation' },
      ],
    },
  ];
}

/**
 * Full-width modal cheat-sheet overlay (opened with `?` on an empty prompt,
 * closed with Esc / `?` / `q`). Mirrors the bordered-panel look of the monitor
 * overlays so it sits naturally in the bottom region. Two columns: the key
 * chord (accent) and its description (dim), with the key column padded to a
 * shared width so descriptions align.
 */
export function HelpOverlay(): React.ReactElement {
  const sections = helpSections();
  const keyWidth = Math.max(...sections.flatMap((s) => s.entries.map((e) => e.keys.length)), 0);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Box flexDirection="row" gap={1}>
        <Text bold color={theme.accent}>
          Keyboard shortcuts
        </Text>
        <Text dimColor>· Esc to close</Text>
      </Box>
      {sections.map((sec) => (
        <Box key={sec.title} flexDirection="column" marginTop={1}>
          <Text bold color={theme.brand}>
            {sec.title}
          </Text>
          {sec.entries.map((e, i) => (
            <Box
              // biome-ignore lint/suspicious/noArrayIndexKey: positional, stable per section
              key={i}
              flexDirection="row"
            >
              <Text color={theme.accent}>{e.keys.padEnd(keyWidth + 2)}</Text>
              <Text dimColor>{e.desc}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}
