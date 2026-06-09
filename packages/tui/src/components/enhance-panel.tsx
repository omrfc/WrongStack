import { Box, Text, useInput } from '../ink.js';
import React from 'react';

export type EnhanceDecision = 'refined' | 'english' | 'original' | 'edit';

export interface EnhancePanelProps {
  /** The user's original message. */
  original: string;
  /** Refined in the user's original language. */
  refined: string;
  /** Refined in English. */
  english: string;
  /** Auto-send countdown in milliseconds. */
  delayMs: number;
  /** Called once with the chosen action (by key press or countdown expiry). */
  onDecision: (decision: EnhanceDecision) => void;
  /**
   * Called every second with the remaining seconds. Lets the statusline
   * render the countdown without the panel's re-renders bleeding into the
   * chat scrollback as blank entries.
   */
  onTick?: ((remaining: number) => void) | undefined;
}

/**
 * Prompt-refinement preview ("did you mean this?"). Shows the refined request
 * in both the user's language and English with a live countdown; auto-sends
 * the original-language refined version when the countdown expires unless the
 * user intervenes:
 *   Enter → send original-lang refined now
 *   e     → send English refined
 *   Esc   → use original
 *   t     → edit the original-lang refined version
 *
 * Self-contained like ConfirmPrompt: owns its keys via `useInput` and its
 * timer via `useEffect`. `onDecision` is guarded by the caller so only the
 * first decision wins.
 */
export function EnhancePanel({
  original,
  refined,
  english,
  delayMs,
  onDecision,
  onTick,
}: EnhancePanelProps): React.ReactElement {
  const totalSecs = Math.max(1, Math.ceil(delayMs / 1000));

  // Countdown runs internally via a ref — no React state, no re-renders, no
  // blank entries bleeding into the chat scrollback. The statusline receives
  // ticks via onTick() and owns the visible display.
  const remainingRef = React.useRef(totalSecs);

  // Tick the countdown once per second; fire 'refined' when it reaches 0.
  // The latest callbacks are read from refs so the interval never goes stale.
  const decideRef = React.useRef(onDecision);
  decideRef.current = onDecision;
  const tickRef = React.useRef(onTick);
  tickRef.current = onTick;
  React.useEffect(() => {
    const id = setInterval(() => {
      const r = remainingRef.current - 1;
      remainingRef.current = r;
      tickRef.current?.(r);
      if (r <= 0) {
        clearInterval(id);
        decideRef.current('refined');
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  useInput((input, key) => {
    if (key.return) {
      onDecision('refined');
    } else if (key.escape) {
      onDecision('original');
    } else if (input?.toLowerCase() === 'e') {
      onDecision('english');
    } else if (input?.toLowerCase() === 't') {
      onDecision('edit');
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box flexDirection="row">
        <Text bold color="cyan">
          ✨ Refined request
        </Text>
      </Box>
      <Box flexDirection="row">
        <Text dimColor>original: </Text>
        <Text dimColor>{original}</Text>
      </Box>
      <Box flexDirection="row">
        <Text color="yellow">refined:  </Text>
        <Text color="white">{refined}</Text>
      </Box>
      <Box flexDirection="row">
        <Text color="green">english:  </Text>
        <Text color="white">{english}</Text>
      </Box>
      <Text dimColor>─────────────────</Text>
      <Box flexDirection="row">
        <Text>
          <Text bold color="yellow">
            [Enter]
          </Text>
          <Text dimColor> refined · </Text>
          <Text bold color="green">
            [e]
          </Text>
          <Text dimColor> english · </Text>
          <Text bold color="cyan">
            [t]
          </Text>
          <Text dimColor> edit · </Text>
          <Text bold color="red">
            [Esc]
          </Text>
          <Text dimColor> original</Text>
        </Text>
      </Box>
    </Box>
  );
}
