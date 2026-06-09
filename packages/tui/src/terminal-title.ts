import type { EventBus } from '@wrongstack/core';

/**
 * Animated terminal/tab title for the TUI.
 *
 * Writes an OSC-0 sequence (`ESC ] 0 ; <text> BEL`) — an out-of-band terminal
 * command that sets the window/tab title without touching the screen, so it
 * never corrupts Ink's render. The title animates: a braille spinner plus a
 * live status derived from the agent's EventBus (thinking / running a tool),
 * and a gentle scrolling marquee when idle. Reset to a static title on stop.
 *
 * Disable with WRONGSTACK_NO_TITLE=1.
 */

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const setTitle = (s: string): string => `\x1b]0;${s}\x07`;

/** A marquee window over `text`, advancing by `offset`. */
function marquee(text: string, offset: number, width: number): string {
  const padded = `${text}   `;
  const start = offset % padded.length;
  return (padded + padded).slice(start, start + width);
}

export interface TerminalTitleOptions {
  stdout: NodeJS.WriteStream;
  events: EventBus;
  model?: string | undefined;
  appName?: string | undefined;
  intervalMs?: number | undefined;
  /** ms of silence before the title falls back to the idle marquee. */
  idleAfterMs?: number | undefined;
}

export function startTerminalTitle(opts: TerminalTitleOptions): () => void {
  const { stdout, events } = opts;
  if (process.env['WRONGSTACK_NO_TITLE'] === '1' || !stdout.isTTY) {
    return () => {};
  }

  const app = opts.appName ?? 'WrongStack';
  const idleAfter = opts.idleAfterMs ?? 3500;
  const suffix = ` · ${app}`;

  let frame = 0;
  let scroll = 0;
  let phase: 'idle' | 'thinking' | 'tool' = 'idle';
  let toolName = '';
  let lastActivity = 0; // 0 → never active yet, start idle

  const touch = (next: 'thinking' | 'tool', tool?: string) => {
    phase = next;
    if (tool) toolName = tool;
    lastActivity = Date.now();
  };

  const offs: Array<() => void> = [
    events.on('iteration.started', () => touch('thinking')),
    events.on('provider.text_delta', () => touch('thinking')),
    events.on('provider.thinking_delta', () => touch('thinking')),
    events.on('tool.started', (e) => touch('tool', (e as { name?: string | undefined }).name ?? 'tool')),
    events.on('tool.executed', () => touch('thinking')),
  ];

  const write = (s: string) => {
    try {
      stdout.write(s);
    } catch {
      /* stdout closed during shutdown */
    }
  };

  const timer = setInterval(() => {
    frame = (frame + 1) % SPINNER.length;
    scroll += 1;
    if (lastActivity && Date.now() - lastActivity > idleAfter) phase = 'idle';

    const sp = SPINNER[frame];
    let title: string;
    if (phase === 'tool') {
      title = `${sp} ▸ ${toolName}${suffix}`;
    } else if (phase === 'thinking') {
      title = `${sp} thinking…${suffix}`;
    } else {
      // Idle: scroll the app name + model so the tab still feels alive.
      title = marquee(`✦ ${app}${suffix}`, scroll >> 1, 22);
    }
    write(setTitle(title));
  }, opts.intervalMs ?? 130);
  // Don't keep the event loop alive just for the title animation.
  timer.unref?.();

  return () => {
    clearInterval(timer);
    for (const off of offs) off();
    write(setTitle(app));
  };
}
