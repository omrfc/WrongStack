import { Box, Text } from '../../ink.js';
import React, { useEffect, useMemo } from 'react';
import { theme } from '../../theme.js';
import { getToolVisual } from '../../tool-glyph.js';
import { Banner } from './banner.js';
import { DiffBlock, extractDiffPreview } from './code-block.js';
import { parseNextSteps } from '../suggestions.js';
import type { ParsedNextStep } from '../suggestions.js';
import type { HistoryEntry } from './types.js';
import { AssistantBody, assistantContentWidth } from './assistant.js';
import {
  fmtBytes,
  fmtDuration,
  fmtTok,
  formatToolArgs,
  formatToolOutput,
  formatToolVisualOutput,
  ToolOutputLines,
} from './utils.js';

// ── Internal helpers ──

function brainStatusStyle(status: Extract<HistoryEntry, { kind: 'brain' }>['status']): {
  icon: string;
  color: string;
} {
  switch (status) {
    case 'thinking':
      return { icon: '…', color: 'magenta' };
    case 'answered':
      return { icon: '⚖', color: 'cyan' };
    case 'ask_human':
      return { icon: '?', color: 'yellow' };
    case 'denied':
      return { icon: '×', color: 'red' };
    case 'intervention':
      return { icon: '⚡', color: 'yellow' };
  }
}

function brainRiskColor(risk: Extract<HistoryEntry, { kind: 'brain' }>['risk']): string {
  switch (risk) {
    case 'low':
      return 'green';
    case 'medium':
      return 'cyan';
    case 'high':
      return 'yellow';
    case 'critical':
      return 'red';
  }
}

// ── Entry ──

export const Entry = React.memo(function Entry({
  entry,
  termWidth,
  setSuggestions,
  autonomyMode,
  autoSubmitCountdown,
}: {
  entry: HistoryEntry;
  termWidth: number;
  /** Store parsed next steps in the shared suggestion store so /next 1 works. */
  setSuggestions?: ((steps: string[]) => void) | undefined;
  /** Current autonomy mode — when 'auto', first step shows an auto marker. */
  autonomyMode?: string | undefined;
  /** Seconds remaining in the auto-submit countdown — shown as a live badge. */
  autoSubmitCountdown?: number | null | undefined;
}): React.ReactElement {
  // Parse next steps from assistant text — computed once, used only in
  // the assistant case. Must live at the top level (hooks rules).
  const nextSteps = useMemo(() => {
    if (entry.kind !== 'assistant') return { steps: [] as ParsedNextStep[], stripped: '' };
    // strict=true: accepts 💡 emoji heading OR <next_steps> XML tag
    return parseNextSteps(entry.text, true);
  }, [entry.kind, (entry as never as { text?: string }).text]);

  // Store parsed next steps in the shared suggestion store (for /next and
  // auto-submit countdown). Strict=true accepts 💡 headings or <next_steps> XML tags
  // (consistent with what the TUI renders in the message body).
  // NOTE: Only assistant entries should have <next_steps> — subagents return
  // task results, not suggestions, so we skip parsing for subagent entries.
  useEffect(() => {
    if (!setSuggestions) return;
    if (entry.kind !== 'assistant') return;
    const text = (entry as never as { text?: string }).text ?? '';
    const { texts } = parseNextSteps(text, true);
    if (texts.length > 0) setSuggestions(texts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.kind, (entry as never as { text?: string }).text, setSuggestions]);

  switch (entry.kind) {
    case 'user':
      return (
        <Box
          marginX={0}
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor={theme.user}
          paddingLeft={1}
        >
          <Text>
            <Text bold color={theme.user}>
              {'USER  '}
            </Text>
            <Text color="white">{entry.text}</Text>
            {entry.queued ? <Text dimColor>{' (queued)'}</Text> : null}
            {entry.pasteContent ? (
              <>
                {entry.text ? '\n' : null}
                <Text dimColor>
                  {'  ↳ '}
                  {entry.pasteContent}
                </Text>
              </>
            ) : null}
          </Text>
        </Box>
      );
    case 'assistant': {
      const contentWidth = assistantContentWidth(termWidth);
      const { steps, stripped } = nextSteps;
      const hasNext = steps.length > 0;
      return (
        <Box flexDirection="column">
          <Box
            flexDirection="column"
            marginX={0}
            marginY={1}
            borderStyle="single"
            borderTop={false}
            borderRight={false}
            borderBottom={false}
            borderColor={theme.assistant}
            paddingLeft={1}
          >
            <Box flexDirection="row">
              <Text bold color={theme.assistant}>
                {'ASSISTANT'}
              </Text>
            </Box>
            <AssistantBody text={stripped} termWidth={termWidth} contentWidth={contentWidth} />
          </Box>
          {hasNext && (
            <Box
              flexDirection="column"
              marginX={0}
              marginY={1}
              borderStyle="single"
              borderTop={false}
              borderRight={false}
              borderBottom={false}
              borderColor={theme.accent}
              paddingLeft={1}
            >
              <Box flexDirection="row">
                <Text bold color={theme.accent}>
                  {'💡 NEXT STEPS  '}
                </Text>
                <Text dimColor>(use /next 1, /next 1 2 3 to select)</Text>
              </Box>
              {steps.map((s, i) => (
                <Box key={s.index} flexDirection="row" marginTop={0}>
                  <Text>
                    <Text bold color={theme.accent}>{`  ${s.index}. `}</Text>
                    <Text>{s.text}</Text>
                    {s.auto ? (
                      <Text color="cyan" dimColor>  auto</Text>
                    ) : null}
                    {autonomyMode === 'auto' && i === 0 ? (
                      autoSubmitCountdown != null && autoSubmitCountdown > 0 ? (
                        <Text color={
                          autoSubmitCountdown > 20 ? 'green'
                          : autoSubmitCountdown > 10 ? 'yellow'
                          : 'red'
                        }>{`  auto in ${autoSubmitCountdown}s`}</Text>
                      ) : (
                        <Text color="cyan">{'  ⏩'}</Text>
                      )
                    ) : null}
                  </Text>
                </Box>
              ))}
            </Box>
          )}
        </Box>
      );
    }
    case 'tool': {
      const { glyph, color } = getToolVisual(entry.name);
      const argSummary = formatToolArgs(entry.name, entry.input);
      const outLines = formatToolOutput(
        entry.name,
        entry.output,
        entry.ok,
        entry.outputBytes,
        entry.outputLines,
      );
      const visualLines = formatToolVisualOutput(entry.name, entry.output, entry.ok, entry.input);
      const diff = entry.ok ? extractDiffPreview(entry.name, entry.output, entry.input) : undefined;
      const sizeChip = (() => {
        if (!entry.ok) return '';
        const parts: string[] = [];
        if (entry.outputLines !== undefined && entry.outputLines > 0) {
          parts.push(`${entry.outputLines} L`);
        }
        if (entry.outputBytes && entry.outputBytes > 0) {
          parts.push(fmtBytes(entry.outputBytes));
        }
        if (entry.outputTokens && entry.outputTokens > 0) {
          parts.push(`≈${fmtTok(entry.outputTokens)} tok`);
        }
        return parts.join(' · ');
      })();
      return (
        <Box flexDirection="column">
          <Text>
            <Text color={color}>{glyph}</Text>
            <Text>{' '}</Text>
            <Text bold color={color}>
              {entry.name}
            </Text>
            {argSummary ? (
              <>
                <Text>{'  '}</Text>
                <Text dimColor>{argSummary}</Text>
              </>
            ) : null}
            <Text dimColor>{`  ·  ${fmtDuration(entry.durationMs)}`}</Text>
            {sizeChip ? <Text dimColor>{`  ·  ${sizeChip}`}</Text> : null}
          </Text>
          {visualLines ? (
            <ToolOutputLines lines={visualLines} hasFollowingBlock={Boolean(diff)} />
          ) : (
            outLines.map((line, i) => (
              <Text key={i}>
                <Text dimColor>{i === outLines.length - 1 && !diff ? '  └─ ' : '  ├─ '}</Text>
                <Text
                  dimColor={entry.ok && !line.startsWith('!')}
                  {...(!entry.ok || line.startsWith('!') ? { color: 'red' } : {})}
                >
                  {line}
                </Text>
              </Text>
            ))
          )}
          {diff ? (
            <DiffBlock
              rows={diff.rows}
              hidden={diff.hidden}
              hiddenAdded={diff.hiddenAdded}
              hiddenRemoved={diff.hiddenRemoved}
            />
          ) : null}
        </Box>
      );
    }
    case 'info': {
      // Slash commands style their own output with raw ANSI (bold, colors,
      // dim sections). Wrapping that in dimColor breaks mid-string: the
      // first \x1b[22m close inside the text cancels the outer dim, leaving
      // the rest of the entry patchy half-dim/half-bright. Only dim plain,
      // unstyled lines.
      const hasAnsi = /\x1b\[/.test(entry.text);
      return <Text dimColor={!hasAnsi}>{entry.text}</Text>;
    }
    case 'warn':
      return (
        <Box
          marginX={0}
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor={theme.warn}
          paddingLeft={1}
        >
          <Text color={theme.warn}>{entry.text}</Text>
        </Box>
      );
    case 'error':
      return (
        <Box
          marginX={0}
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor={theme.error}
          paddingLeft={1}
        >
          <Text color={theme.error}>{entry.text}</Text>
        </Box>
      );
    case 'turn-summary':
      return <Text dimColor>{entry.text}</Text>;
    case 'brain': {
      const statusStyle = brainStatusStyle(entry.status);
      const riskColor = brainRiskColor(entry.risk);
      return (
        <Box
          flexDirection="column"
          marginX={0}
          marginY={1}
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor="magenta"
          paddingLeft={1}
        >
          <Box flexDirection="row" gap={1}>
            <Text bold color="magenta">
              BRAIN
            </Text>
            <Text color={statusStyle.color}>{statusStyle.icon}</Text>
            <Text dimColor>{entry.source}</Text>
            <Text dimColor>·</Text>
            <Text color={riskColor}>{entry.risk}</Text>
          </Box>
          <Text color="white">{entry.question}</Text>
          {entry.decision ? (
            <Text>
              <Text dimColor>Decision: </Text>
              <Text color={statusStyle.color}>{entry.decision}</Text>
            </Text>
          ) : null}
          {entry.rationale ? <Text dimColor>{entry.rationale}</Text> : null}
        </Box>
      );
    }
    case 'confirm':
      return (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
          marginY={1}
        >
          <Text bold color="yellow">
            ⚠ Confirm: {entry.toolName}
          </Text>
          <Text dimColor>Waiting for y / n / a / d...</Text>
        </Box>
      );
    case 'banner':
      return <Banner entry={entry} />;
    case 'subagent': {
      const lines = entry.text.split('\n');
      return (
        <Box flexDirection="column">
          <Text>
            <Text color={entry.agentColor} bold>
              {`[${entry.agentLabel}]`}
            </Text>
            <Text> </Text>
            <Text color={entry.agentColor}>{entry.icon}</Text>
            <Text> </Text>
            <Text>{lines[0] ?? ''}</Text>
            {entry.detail ? (
              <>
                <Text dimColor>{'  ·  '}</Text>
                <Text dimColor>{entry.detail}</Text>
              </>
            ) : null}
          </Text>
          {lines.slice(1).map((line, i) => (
            <Text key={i}>
              <Text dimColor>{'  '}</Text>
              <Text>{line}</Text>
            </Text>
          ))}
        </Box>
      );
    }
  }
});
