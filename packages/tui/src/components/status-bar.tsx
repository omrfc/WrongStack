import React from 'react';
import { Box, Text } from 'ink';
import type { TokenCounter } from '@wrongstack/core';
import type { GitInfo } from '../git-info.js';

export interface TodoCounts {
  pending: number;
  inProgress: number;
  completed: number;
}

export interface ContextWindow {
  /** Input tokens of the most recent provider request — the de-facto live context size. */
  used: number;
  /** Provider's declared maxContext capability. */
  max: number;
}

export interface StatusBarProps {
  model: string;
  state: 'idle' | 'running' | 'streaming' | 'aborting';
  tokenCounter?: TokenCounter;
  hint?: string;
  queueCount?: number;
  yolo?: boolean;
  /** Session elapsed in milliseconds. Renders as `mm:ss` (< 1h) or `h:mm:ss`. */
  elapsedMs?: number;
  todos?: TodoCounts;
  git?: GitInfo | null;
  subagentCount?: number;
  /** Renders the "ctx ████░░ 42%" chip on line 1 when present. */
  context?: ContextWindow;
}

/**
 * Two-line status bar. The first line stays compact and shows the
 * runtime essentials (state · model · tokens · cost · queue · running
 * tool). The second line opts in only when there's actually something
 * to show — git branch, elapsed time, todo counts, YOLO marker — so a
 * vanilla session keeps the original single-line footprint.
 */
export function StatusBar({
  model,
  state,
  tokenCounter,
  hint,
  queueCount = 0,
  yolo = false,
  elapsedMs,
  todos,
  git,
  subagentCount = 0,
  context,
}: StatusBarProps): React.ReactElement {
  const usage = tokenCounter?.total();
  const cost = tokenCounter?.estimateCost();
  const cache = tokenCounter?.cacheStats();
  const stateColor =
    state === 'idle' ? 'cyan' : state === 'aborting' ? 'yellow' : 'green';
  const stateLabel =
    state === 'idle' ? 'idle' : state === 'aborting' ? 'aborting…' : 'thinking…';

  const hasSecondLine =
    yolo ||
    elapsedMs !== undefined ||
    (todos && (todos.pending > 0 || todos.inProgress > 0 || todos.completed > 0)) ||
    (git !== null && git !== undefined) ||
    subagentCount > 0;

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      borderStyle="single"
      borderTop={true}
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
    >
      <Box flexDirection="row" gap={2}>
        <Text color={stateColor}>● {stateLabel}</Text>
        <Text dimColor>│</Text>
        <Text color="magenta">{model}</Text>
        {context && context.max > 0 ? (
          <>
            <Text dimColor>│</Text>
            <ContextChip ctx={context} />
          </>
        ) : null}
        {usage ? (
          <>
            <Text dimColor>│</Text>
            <Text>
              ↑ <Text color="cyan">{fmtTok(usage.input)}</Text> ↓{' '}
              <Text color="cyan">{fmtTok(usage.output)}</Text>
            </Text>
          </>
        ) : null}
        {cache && cache.hitRatio > 0 ? (
          <>
            <Text dimColor>│</Text>
            <Text dimColor>cache {(cache.hitRatio * 100).toFixed(0)}%</Text>
          </>
        ) : null}
        {cost && cost.total > 0 ? (
          <>
            <Text dimColor>│</Text>
            <Text color="yellow">${cost.total.toFixed(4)}</Text>
          </>
        ) : null}
        {queueCount > 0 ? (
          <>
            <Text dimColor>│</Text>
            <Text color="cyan">⌛ queued: {queueCount}</Text>
          </>
        ) : null}
        {hint ? (
          <>
            <Text dimColor>│</Text>
            <Text dimColor>{hint}</Text>
          </>
        ) : null}
      </Box>

      {hasSecondLine ? (
        <Box flexDirection="row" gap={2}>
          {yolo ? (
            <Text color="red" bold>
              ⚠ YOLO
            </Text>
          ) : null}
          {elapsedMs !== undefined ? (
            <>
              {yolo ? <Text dimColor>│</Text> : null}
              <Text dimColor>⏱ {fmtElapsed(elapsedMs)}</Text>
            </>
          ) : null}
          {git ? (
            <>
              {yolo || elapsedMs !== undefined ? <Text dimColor>│</Text> : null}
              <Text>
                <Text color="magenta">⎇ {git.branch}</Text>
                {git.added > 0 ? <Text color="green"> +{git.added}</Text> : null}
                {git.deleted > 0 ? <Text color="red"> -{git.deleted}</Text> : null}
                {git.untracked > 0 ? <Text dimColor> ?{git.untracked}</Text> : null}
              </Text>
            </>
          ) : null}
          {todos && (todos.pending > 0 || todos.inProgress > 0 || todos.completed > 0) ? (
            <>
              <Text dimColor>│</Text>
              <Text>
                {todos.inProgress > 0 ? <Text color="yellow">⌛ {todos.inProgress}</Text> : null}
                {todos.inProgress > 0 && (todos.pending > 0 || todos.completed > 0) ? ' ' : ''}
                {todos.pending > 0 ? <Text dimColor>☐ {todos.pending}</Text> : null}
                {todos.pending > 0 && todos.completed > 0 ? ' ' : ''}
                {todos.completed > 0 ? <Text color="green">✓ {todos.completed}</Text> : null}
              </Text>
            </>
          ) : null}
          {subagentCount > 0 ? (
            <>
              <Text dimColor>│</Text>
              <Text color="blue">🌐 {subagentCount} agent{subagentCount === 1 ? '' : 's'}</Text>
            </>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}

function ContextChip({ ctx }: { ctx: ContextWindow }): React.ReactElement {
  const ratio = Math.max(0, Math.min(1, ctx.used / ctx.max));
  const pct = Math.round(ratio * 100);
  // Colour ramp: cool while there's plenty of headroom, warn at the
  // two-thirds mark, alarm once we're inside the last 20% — the model
  // typically starts losing the head of the conversation around there.
  const color = ratio >= 0.85 ? 'red' : ratio >= 0.65 ? 'yellow' : 'cyan';
  return (
    <Text>
      <Text dimColor>ctx </Text>
      <Text color={color}>{renderProgress(ratio, 10)}</Text>
      <Text color={color}> {pct}%</Text>
      <Text dimColor>
        {' '}
        ({fmtTok(ctx.used)}/{fmtTok(ctx.max)})
      </Text>
    </Text>
  );
}

const FILLED = '█';
const EMPTY = '░';

/**
 * Render a ratio 0..1 as a width-N block bar. We round to the nearest
 * cell rather than flooring so a 5% bar still shows one filled cell —
 * otherwise low-usage sessions look identical to an empty start.
 */
export function renderProgress(ratio: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = clamped === 0 ? 0 : Math.max(1, Math.round(clamped * width));
  const capped = Math.min(width, filled);
  return FILLED.repeat(capped) + EMPTY.repeat(width - capped);
}

function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${pad2(m)}:${pad2(s)}`;
  }
  return `${pad2(m)}:${pad2(s)}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
