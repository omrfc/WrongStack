import React from 'react';
import { render } from 'ink';
import type {
  Agent,
  AttachmentStore,
  EventBus,
  QueueStore,
  SlashCommandRegistry,
  TokenCounter,
} from '@wrongstack/core';
import { App } from './app.js';

export interface RunTuiOptions {
  agent: Agent;
  slashRegistry: SlashCommandRegistry;
  attachments: AttachmentStore;
  events: EventBus;
  tokenCounter?: TokenCounter;
  model: string;
  banner?: boolean;
  /** Persists the input queue across crashes; if omitted, the queue is in-memory only. */
  queueStore?: QueueStore;
  /** Surfaces the "⚠ YOLO" chip in the status bar. */
  yolo?: boolean;
  /**
   * Render into the terminal's alternate screen buffer (like vim/less/htop)
   * so the input + status bar stay truly fixed and never leak into
   * scrollback. Default: true. Pass false to keep the legacy
   * scrollback-as-history behaviour (chat survives in the terminal
   * after exit, at the cost of dynamic-area duplication artifacts).
   */
  altScreen?: boolean;
  /**
   * Called right after we exit the alt-screen on a clean shutdown. The
   * CLI uses this to print a one-line "session saved to …" hint into
   * the user's normal terminal, since alt-screen exit erases the whole
   * TUI view.
   */
  onAfterExit?: () => void;
}

// Bracketed paste mode wraps any pasted text with these markers, letting us
// distinguish a paste from typed input even when chunks arrive identically.
const BRACKETED_PASTE_ON = '\x1b[?2004h';
const BRACKETED_PASTE_OFF = '\x1b[?2004l';

// Alternate-screen buffer (DECSET 1049). Switches the terminal to a
// dedicated virtual screen; on exit, the previous scrollback is restored
// untouched. This is what every "full-screen TUI" uses (vim, less, htop).
// Without it, Ink writes its dynamic area in line with scrollback and
// each redraw can leak the previous frame's input/status into the
// permanent terminal history — the exact bug we hit before this change.
const ALT_SCREEN_ON = '\x1b[?1049h';
const ALT_SCREEN_OFF = '\x1b[?1049l';
const CURSOR_HOME = '\x1b[H';

export async function runTui(opts: RunTuiOptions): Promise<number> {
  const stdout = process.stdout;
  const stdin = process.stdin;

  // Ink requires a TTY on both stdin and stdout. Without this guard the
  // render call would fail with a terse internal Ink error; bail with a
  // clear message so a piped invocation (`echo hi | wstack --tui`) tells
  // the user what to do instead.
  if (!stdout.isTTY || !stdin.isTTY) {
    process.stderr.write(
      'wstack: --tui requires an interactive terminal on both stdin and stdout.\n' +
        '       Drop the flag (use the plain REPL) or run wstack directly without piping.\n',
    );
    return 2;
  }

  const useAltScreen = opts.altScreen !== false;
  if (useAltScreen) {
    stdout.write(ALT_SCREEN_ON);
    stdout.write(CURSOR_HOME);
  }
  stdout.write(BRACKETED_PASTE_ON);

  // Track cleanup state so signal handlers don't double-disable. Order
  // matters on exit: paste mode off first (it's a screen-independent
  // setting), then alt-screen off (which restores the user's previous
  // terminal contents).
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      stdout.write(BRACKETED_PASTE_OFF);
      if (useAltScreen) {
        stdout.write(ALT_SCREEN_OFF);
      }
    } catch {
      // stdout may already be closed during shutdown — ignore.
    }
  };

  // If the process is killed externally (terminal closed, SIGTERM from a
  // supervisor) waitUntilExit's .then/.catch never runs. Register signal +
  // exit listeners so the terminal isn't left in bracketed-paste mode.
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGHUP', 'SIGINT'];
  const signalHandler = () => cleanup();
  const exitHandler = () => cleanup();
  for (const s of signals) process.on(s, signalHandler);
  process.on('exit', exitHandler);

  const detachListeners = () => {
    for (const s of signals) process.off(s, signalHandler);
    process.off('exit', exitHandler);
  };

  return new Promise<number>((resolve) => {
    let exitCode = 0;
    const onExit = (code: number) => {
      exitCode = code;
    };
    const settle = (code: number) => {
      cleanup();
      detachListeners();
      // Once the alt-screen is dismantled the user is staring at their
      // pre-TUI terminal again — print a quick line so they can see
      // where the session is preserved, instead of wondering "where did
      // my chat go?". Best-effort: callback failures don't change exit.
      if (useAltScreen && opts.onAfterExit) {
        try {
          opts.onAfterExit();
        } catch {
          // ignore — UX helper, not load-bearing
        }
      }
      resolve(code);
    };

    let instance: ReturnType<typeof render>;
    try {
      instance = render(
        React.createElement(App, {
          agent: opts.agent,
          slashRegistry: opts.slashRegistry,
          attachments: opts.attachments,
          events: opts.events,
          tokenCounter: opts.tokenCounter,
          model: opts.model,
          banner: opts.banner ?? true,
          queueStore: opts.queueStore,
          yolo: opts.yolo,
          onExit,
        }),
        { exitOnCtrlC: false },
      );
    } catch (err) {
      process.stderr.write(
        `wstack: TUI failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      settle(1);
      return;
    }
    instance
      .waitUntilExit()
      .then(() => settle(exitCode))
      .catch(() => settle(1));
  });
}
