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
}

// Bracketed paste mode wraps any pasted text with these markers, letting us
// distinguish a paste from typed input even when chunks arrive identically.
const BRACKETED_PASTE_ON = '\x1b[?2004h';
const BRACKETED_PASTE_OFF = '\x1b[?2004l';

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

  stdout.write(BRACKETED_PASTE_ON);

  // Track cleanup state so signal handlers don't double-disable.
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      stdout.write(BRACKETED_PASTE_OFF);
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
