import { Box, Text, useInput } from 'ink';
import React from 'react';

export interface ConfirmPromptProps {
  toolName: string;
  input: unknown;
  suggestedPattern: string;
  onDecision: (decision: 'yes' | 'no' | 'always' | 'deny') => void;
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
    process.stdout.write('\x07');
  }, []);

  useInput((input, key) => {
    console.log('[ConfirmPrompt] useInput received: input=', JSON.stringify(input), 'key=', JSON.stringify(key));
    if (input.length === 0) return; // ignore special keys — only accept explicit chars
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

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      marginY={1}
    >
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
          <Text bold color="green">
            [y]
          </Text>
          <Text dimColor>es </Text>
          <Text bold color="red">
            [n]
          </Text>
          <Text dimColor>o </Text>
          <Text bold color="cyan">
            [a]
          </Text>
          <Text dimColor>lways ({suggestedPattern}) </Text>
          <Text bold color="red">
            [d]
          </Text>
          <Text dimColor>eny</Text>
        </Text>
      </Box>
    </Box>
  );
}
