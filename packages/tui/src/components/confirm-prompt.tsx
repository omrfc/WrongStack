import { Box, Text, useInput } from 'ink';
import { writeOut } from '@wrongstack/core';
import React from 'react';

export type ConfirmDecision = 'yes' | 'no' | 'always' | 'deny';

export interface ConfirmPromptProps {
  toolName: string;
  input: unknown;
  suggestedPattern: string;
  onDecision: (decision: ConfirmDecision) => void;
}

/** Ink color for each button's bracketed key. */
const BUTTON_COLOR: Record<ConfirmDecision, string> = {
  yes: 'green',
  no: 'red',
  always: 'cyan',
  deny: 'red',
};

/**
 * The button row as a list of {bracket, rest} segments. Single source of
 * truth for BOTH the rendered row and the mouse hit-test geometry
 * (`confirmButtonSegments`), so they can never drift. `rest` carries the
 * trailing space that separates one button from the next.
 */
function buttonLabels(suggestedPattern: string): Array<{
  decision: ConfirmDecision;
  bracket: string;
  rest: string;
}> {
  return [
    { decision: 'yes', bracket: '[y]', rest: 'es ' },
    { decision: 'no', bracket: '[n]', rest: 'o ' },
    { decision: 'always', bracket: '[a]', rest: `lways (${suggestedPattern}) ` },
    { decision: 'deny', bracket: '[d]', rest: 'eny' },
  ];
}

/**
 * 0-based column spans of each button WITHIN the dialog's content area (i.e.
 * relative to the first printable column inside the border + paddingX). Used
 * by the TUI mouse handler to map a click on the button row to a decision.
 * Derived from the same `buttonLabels` the component renders, so the offsets
 * always match what's on screen.
 */
export function confirmButtonSegments(
  suggestedPattern: string,
): Array<{ decision: ConfirmDecision; start: number; len: number }> {
  const out: Array<{ decision: ConfirmDecision; start: number; len: number }> = [];
  let col = 0;
  for (const l of buttonLabels(suggestedPattern)) {
    const len = l.bracket.length + l.rest.length;
    out.push({ decision: l.decision, start: col, len });
    col += len;
  }
  return out;
}

function stringifyInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  return Object.entries(obj)
    .filter(([k]) => k !== 'content' && k !== 'new_string')
    .map(([k, v]) => `${k}: ${truncate(JSON.stringify(v), 80)}`)
    .join('  ');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function hasDiff(input: unknown): boolean {
  return Boolean(
    input && typeof input === 'object' && 'diff' in (input as Record<string, unknown>),
  );
}

function renderDiffLine(line: string): React.ReactElement {
  const prefix = line.startsWith('+')
    ? 'green'
    : line.startsWith('-')
      ? 'red'
      : line.startsWith('@@')
        ? 'cyan'
        : undefined;
  return (
    <Text key={line} color={prefix}>
      {line}
      {'\n'}
    </Text>
  );
}

function renderDiff(diff: string): React.ReactElement {
  const lines = diff
    .split('\n')
    .filter((l) => l.length > 0)
    .slice(0, 20);
  return (
    <Box flexDirection="column" paddingX={2}>
      {lines.map((l) => renderDiffLine(l))}
    </Box>
  );
}

export function ConfirmPrompt({
  toolName,
  input,
  suggestedPattern,
  onDecision,
}: ConfirmPromptProps): React.ReactElement {
  // Terminal bell on mount — alerts the user that action is required,
  // especially important when the agent has been running autonomously
  // and the user may not be staring at the terminal.
  React.useEffect(() => {
    writeOut('\x07');
  }, []);

  useInput((input, _key) => {
    // Ignore empty input and CRLF/LF artifacts (Enter produces \r on Windows, \n on Unix)
    if (!input || input === '\r' || input === '\n') return;
    const ch = input.toLowerCase();
    if (ch === 'y') {
      onDecision('yes');
    } else if (ch === 'n') {
      onDecision('no');
    } else if (ch === 'a') {
      onDecision('always');
    } else if (ch === 'd') {
      onDecision('deny');
    }
  });

  const inputSummary = stringifyInput(input);
  const showDiff = hasDiff(input);
  const inp = input as { diff?: unknown };
  const diff = typeof inp?.diff === 'string' ? inp.diff : '';

  // NOTE: no marginY here — the call site wraps this in a measured Box that
  // owns the vertical margin, so `measureElement` on the wrapper reports the
  // exact box height (top border + content + bottom border) the mouse
  // hit-test relies on to locate the button row.
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Box flexDirection="row">
        <Text bold color="yellow">
          ⚠ APPROVAL REQUIRED
        </Text>
        <Text> </Text>
        <Text bold color="white">
          {toolName}
        </Text>
      </Box>
      {inputSummary ? <Text dimColor>{inputSummary}</Text> : null}
      {showDiff && diff ? (
        <Box flexDirection="column" marginY={1}>
          {renderDiff(diff)}
        </Box>
      ) : null}
      <Text dimColor>─────────────────</Text>
      <Box flexDirection="row">
        <Text>
          {buttonLabels(suggestedPattern).map((l) => (
            <React.Fragment key={l.decision}>
              <Text bold color={BUTTON_COLOR[l.decision]}>
                {l.bracket}
              </Text>
              <Text dimColor>{l.rest}</Text>
            </React.Fragment>
          ))}
        </Text>
      </Box>
    </Box>
  );
}
