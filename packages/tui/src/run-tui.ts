import React from 'react';
import { render } from 'ink';
import type {
  Agent,
  AttachmentStore,
  EventBus,
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
}

// Bracketed paste mode wraps any pasted text with these markers, letting us
// distinguish a paste from typed input even when chunks arrive identically.
const BRACKETED_PASTE_ON = '\x1b[?2004h';
const BRACKETED_PASTE_OFF = '\x1b[?2004l';

export async function runTui(opts: RunTuiOptions): Promise<number> {
  const stdout = process.stdout;
  if (stdout.isTTY) stdout.write(BRACKETED_PASTE_ON);

  return new Promise<number>((resolve) => {
    let exitCode = 0;
    const onExit = (code: number) => {
      exitCode = code;
    };
    const cleanup = () => {
      if (stdout.isTTY) stdout.write(BRACKETED_PASTE_OFF);
    };
    const instance = render(
      React.createElement(App, {
        agent: opts.agent,
        slashRegistry: opts.slashRegistry,
        attachments: opts.attachments,
        events: opts.events,
        tokenCounter: opts.tokenCounter,
        model: opts.model,
        banner: opts.banner ?? true,
        onExit,
      }),
      { exitOnCtrlC: false },
    );
    instance
      .waitUntilExit()
      .then(() => {
        cleanup();
        resolve(exitCode);
      })
      .catch(() => {
        cleanup();
        resolve(1);
      });
  });
}
