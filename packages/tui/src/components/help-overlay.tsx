import { Box, Text } from 'ink';
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
 * overlay renders identically everywhere. The Navigation section adapts to the
 * active surface — scroll keys only make sense in the managed viewport, wheel/
 * click only when full mouse mode is on.
 */
export function helpSections(opts: { managed: boolean; mouse: boolean }): HelpSection[] {
  const nav: HelpEntry[] = [];
  if (opts.managed) nav.push({ keys: 'PgUp/PgDn', desc: 'scroll chat history' });
  if (opts.mouse)
    nav.push(
      { keys: 'wheel', desc: 'scroll chat history' },
      { keys: 'click', desc: 'select / confirm' },
    );
  nav.push(
    { keys: '↑/↓', desc: 'previous / next input (empty prompt)' },
    { keys: '?', desc: 'open this help (empty prompt)' },
  );

  return [
    { title: 'Navigation', entries: nav },
    {
      title: 'Monitors',
      entries: [
        { keys: 'Ctrl+F', desc: 'fleet orchestration monitor' },
        { keys: 'Ctrl+G', desc: 'agents live monitor' },
        { keys: 'Ctrl+T', desc: 'worktree monitor' },
        { keys: 'Esc', desc: 'close the open monitor / overlay' },
      ],
    },
    {
      title: 'Editing',
      entries: [
        { keys: 'Enter', desc: 'send (queues while the agent is busy)' },
        { keys: 'Esc Esc', desc: 'clear the input buffer' },
        { keys: 'Ctrl+Backspace', desc: 'delete the previous word' },
        { keys: 'Ctrl+C', desc: 'interrupt the run · twice to exit' },
      ],
    },
    {
      title: 'Commands',
      entries: [
        { keys: '/help', desc: 'list all slash commands' },
        { keys: '/model', desc: 'switch the active model' },
        { keys: '/fleet', desc: 'multi-agent fleet controls' },
        { keys: '/goal', desc: 'set an autonomous goal' },
        { keys: '/autonomy', desc: 'autonomy mode (eternal / off)' },
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
export function HelpOverlay({
  managed,
  mouse,
}: {
  managed: boolean;
  mouse: boolean;
}): React.ReactElement {
  const sections = helpSections({ managed, mouse });
  const keyWidth = Math.max(
    ...sections.flatMap((s) => s.entries.map((e) => e.keys.length)),
    0,
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Box flexDirection="row" gap={1}>
        <Text bold color={theme.accent}>
          WrongStack — keys &amp; commands
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
