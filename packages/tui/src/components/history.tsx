import { Box, Static, Text, useStdout } from 'ink';
import React, { useEffect, useState } from 'react';
import { type HLState, type Lang, detectLang, highlightLine } from '../highlight.js';
import { MarkdownView } from '../markdown.js';
import { theme } from '../theme.js';

export type HistoryEntry =
  | { id: number; kind: 'user'; text: string; queued?: boolean; pasteContent?: string }
  | { id: number; kind: 'assistant'; text: string }
  | {
      id: number;
      kind: 'tool';
      name: string;
      durationMs: number;
      ok: boolean;
      input?: unknown;
      output?: string;
      /** Full byte length of the result body the model actually received
       *  (post-cap, post-scrub). Carried separately because `output` is a
       *  ~400-char preview — `outputBytes` is what the model paid for. */
      outputBytes?: number;
      /** ~3.5 chars/token estimate over `outputBytes`. Cheap to render in
       *  the chip; the authoritative count lives in provider.response.usage. */
      outputTokens?: number;
      /** Real line count for tools that have a meaningful one — read counts
       *  numbered prefixes, shell/grep/logs count newlines. Undefined for
       *  tools without a line notion (json, fetch, …). */
      outputLines?: number;
    }
  | { id: number; kind: 'info'; text: string }
  | { id: number; kind: 'warn'; text: string }
  | { id: number; kind: 'error'; text: string }
  | { id: number; kind: 'turn-summary'; text: string }
  | {
      id: number;
      kind: 'brain';
      status: 'thinking' | 'answered' | 'ask_human' | 'denied';
      source: string;
      risk: 'low' | 'medium' | 'high' | 'critical';
      question: string;
      decision?: string;
      rationale?: string;
    }
  | {
      id: number;
      kind: 'banner';
      version: string;
      provider: string;
      model: string;
      cwd: string;
      /** Wire family the provider is configured to speak (anthropic, openai, …). */
      family?: string;
      /** Last 3 chars of the active API key — quick visual confirmation that the right account is wired up. */
      keyTail?: string;
    }
  /** Tool confirmation shown while waiting for the user to approve/deny. */
  | { id: number; kind: 'confirm'; toolName: string; input: unknown; suggestedPattern: string }
  /**
   * Subagent activity surfaced into the leader's history. One entry per
   * tool call, assistant message, spawn, or completion — prefixed with a
   * stable `AGENT#N` label so users can follow each subagent across
   * interleaved output from multiple parallel runs.
   */
  | {
      id: number;
      kind: 'subagent';
      agentLabel: string;
      agentColor: string;
      icon: string;
      text: string;
      detail?: string;
    };

export interface HistoryProps {
  entries: HistoryEntry[];
  streamingText?: string;
  /**
   * Optional live tail of the currently streaming tool. Rendered below the
   * assistant tail so the user sees both at once: model thinking and tool
   * output. Cleared automatically when the tool's `tool.executed` event
   * fires and the final entry lands in `entries`.
   */
  toolStream?: { toolUseId: string; name: string; text: string; startedAt: number } | null;
}

/**
 * Horizontal columns consumed by every bordered message panel in this
 * file (the user / assistant / warn / error cases below). 1 column for
 * the left-border glyph + 1 column for `paddingLeft={1}`. Width-sensitive
 * renderers in the panel body (notably the markdown table renderer) must
 * budget against `termWidth - MESSAGE_PANEL_CHROME_WIDTH`, otherwise they
 * lay out for the full terminal width and Ink wraps the last cell at the
 * right edge, producing a 2-column shift / extra row.
 *
 * Exported so the regression test can assert against the same number the
 * Entry uses — drift between the two would silently re-introduce the bug.
 */
export const MESSAGE_PANEL_CHROME_WIDTH = 2;

/**
 * Compute the real inner content width of an assistant panel. Pulled out
 * as a named helper so the formula lives in exactly one place: both the
 * Entry render and the regression test import this, so a future change
 * to the chrome model (e.g. adding paddingRight) only has to be made
 * here and both sides stay in lockstep.
 */
export function assistantContentWidth(termWidth: number): number {
  return Math.max(20, termWidth - MESSAGE_PANEL_CHROME_WIDTH);
}

export function History({ entries, streamingText, toolStream }: HistoryProps): React.ReactElement {
  const { stdout } = useStdout();
  // Track terminal dimensions imperatively so that every resize triggers a
  // re-render. We snapshot into state rather than deriving directly from
  // useStdout because Static children receive `termWidth` as a prop — if
  // the parent doesn't re-render on resize, the stale value gets baked
  // into committed scrollback entries. This ensures Entry components in
  // both Static (committed) and live-streaming regions use the current
  // width for table wrapping etc.
  const [termSize, setTermSize] = useState({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  });
  useEffect(() => {
    const handleResize = () => {
      setTermSize({ columns: stdout?.columns ?? 80, rows: stdout?.rows ?? 24 });
    };
    process.stdout.on('resize', handleResize);
    return () => {
      process.stdout.off('resize', handleResize);
    };
  }, [stdout]);
  const termWidth = termSize.columns;
  const tail = streamingText ? tailForDisplay(streamingText, MAX_STREAM_DISPLAY_CHARS) : '';
  const toolTail = toolStream?.text
    ? tailForDisplay(toolStream.text, MAX_STREAM_DISPLAY_CHARS)
    : '';

  // Finalized entries go through <Static>: Ink prints each one ONCE and
  // never re-renders them, which means they flow into the terminal's
  // native scrollback. The user scrolls with the terminal's own
  // mechanism (mouse wheel, Shift+PgUp in Windows Terminal/PowerShell,
  // etc.) — we don't need an in-app scrollbar or scroll keys. Trying
  // to manage scroll ourselves clipped older content under a fixed
  // height box and lost it to redraws.
  return (
    <>
      <Static items={entries}>
        {(entry) => (
          <Box key={entry.id} marginBottom={entry.kind === 'turn-summary' ? 1 : 0}>
            <Entry entry={entry} termWidth={termWidth} />
          </Box>
        )}
      </Static>
      {tail ? <AssistantTail text={tail} /> : null}
      {toolTail ? (
        <ToolStreamBox
          name={toolStream!.name}
          text={toolTail}
          startedAt={toolStream!.startedAt}
          termWidth={termWidth}
        />
      ) : null}
    </>
  );
}

/**
 * The live "ASSISTANT: (streaming...)" tail shown below committed history
 * while a response streams in. Extracted so both the legacy `<Static>` History
 * and the scrollable viewport render an identical tail.
 */
export function AssistantTail({ text }: { text: string }): React.ReactElement {
  return (
    <Box
      flexDirection="column"
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
        <Text dimColor>{'  (streaming…)'}</Text>
      </Box>
      <Text color="white">{text}</Text>
    </Box>
  );
}

/** Max code-block lines rendered before a "+N more" footer (mirrors ToolStreamBox). */
const MAX_CODE_LINES = 80;

export interface BodySegment {
  type: 'prose' | 'code';
  text: string;
  lang?: Lang;
}

/**
 * Split assistant text into prose and ```fenced``` code segments, in order.
 * Pure + testable. An unterminated fence treats the remainder as code.
 */
export function splitFencedBlocks(text: string): BodySegment[] {
  const lines = text.split('\n');
  const segs: BodySegment[] = [];
  let prose: string[] = [];
  let code: string[] | null = null;
  let lang: Lang = 'plain';
  const flushProse = () => {
    if (prose.length > 0) {
      segs.push({ type: 'prose', text: prose.join('\n') });
      prose = [];
    }
  };
  for (const line of lines) {
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      if (code === null) {
        flushProse();
        code = [];
        lang = detectLang(fence[1] ?? '');
      } else {
        segs.push({ type: 'code', text: code.join('\n'), lang });
        code = null;
        lang = 'plain';
      }
      continue;
    }
    if (code !== null) code.push(line);
    else prose.push(line);
  }
  if (code !== null) segs.push({ type: 'code', text: code.join('\n'), lang });
  flushProse();
  return segs;
}

/** Syntax-highlighted, framed code block. Each line is a row of <Text color>
 *  segments (never raw ANSI), so Ink measures width by visible glyphs. */
function CodeBlock({
  code,
  lang,
  contentWidth,
}: { code: string; lang: Lang; contentWidth: number }): React.ReactElement {
  let lines = code.replace(/\n+$/, '').split('\n');
  const hidden = Math.max(0, lines.length - MAX_CODE_LINES);
  if (hidden > 0) lines = lines.slice(0, MAX_CODE_LINES);
  const gutterW = String(lines.length).length;
  // Reserve room for the border (1+1), paddingX (1+1), and the line-number
  // gutter so long lines truncate instead of wrapping out of the frame.
  // CodeBlock is already inside a panel with marginLeft=2, so we only subtract
  // its own chrome (border+paddingX = 4 chars) + gutter + 1 space.
  const maxW = Math.max(20, Math.min(contentWidth - 6 - gutterW - 1, 120));
  let carry: HLState = {};
  const rows = lines.map((raw) => {
    const display = raw.length > maxW ? `${raw.slice(0, maxW - 1)}…` : raw;
    const r = highlightLine(display, lang, carry);
    carry = r.carry;
    return r.tokens;
  });
  return (
    <Box
      flexDirection="column"
      marginLeft={2}
      marginY={0}
      borderStyle="round"
      borderColor={theme.borderDefault}
      paddingX={1}
    >
      {lang !== 'plain' ? <Text dimColor>{lang}</Text> : null}
      {rows.map((tokens, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: code lines are positional
        <Text key={i}>
          <Text dimColor>{`${String(i + 1).padStart(gutterW, ' ')} `}</Text>
          {tokens.length === 0
            ? ' '
            : tokens.map((t, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: token order is stable per line
                <Text key={j} color={t.color} dimColor={t.dim} bold={t.bold}>
                  {t.text}
                </Text>
              ))}
        </Text>
      ))}
      {hidden > 0 ? (
        <Text dimColor italic>{`… +${hidden} more line${hidden === 1 ? '' : 's'}`}</Text>
      ) : null}
    </Box>
  );
}

/** Assistant message body: prose (with markdown tables) interleaved with
 *  highlighted code blocks.
 *
 *  - `contentWidth` is the real inner width of the surrounding panel. It is
 *    forwarded to both `MarkdownView` (for tables) and `CodeBlock` (for line
 *    truncation) so neither overflows the panel and forces Ink to wrap the
 *    last cell at the right edge — a 2-column shift / extra row.
 *    Optional, defaults to `termWidth`, so `AssistantBody` is still safe to
 *    call from contexts without a bordered panel.
 */
export function AssistantBody({
  text,
  termWidth,
  contentWidth,
}: {
  text: string;
  termWidth: number;
  /** Real inner width of the surrounding panel. Defaults to `termWidth`. */
  contentWidth?: number;
}): React.ReactElement {
  const segments = splitFencedBlocks(text);
  const inner = contentWidth ?? termWidth;
  return (
    <Box flexDirection="column">
      {segments.map((seg, i) =>
        seg.type === 'code' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segment order is stable
          <CodeBlock key={i} code={seg.text} lang={seg.lang ?? 'plain'} contentWidth={inner} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segment order is stable
          <MarkdownView key={i} text={seg.text} termWidth={inner} />
        ),
      )}
    </Box>
  );
}

export const MAX_STREAM_DISPLAY_CHARS = 480;

const MAX_STREAM_LINES = 8;

/**
 * Rich streaming tool output — framed header with live elapsed time,
 * tail-N output so the screen doesn't flood, and a "N more lines
 * above" indicator when truncated.
 */
export const ToolStreamBox = React.memo(function ToolStreamBox({
  name,
  text,
  startedAt,
  termWidth,
}: {
  name: string;
  text: string;
  startedAt: number;
  termWidth: number;
}): React.ReactElement {
  // Tick every 500ms while streaming to refresh the elapsed counter.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  void tick; // consumed in elapsed calc below

  const elapsedMs = Date.now() - startedAt;
  const lines = text.split('\n');
  const totalLines = lines.length;
  const hidden = Math.max(0, totalLines - MAX_STREAM_LINES);
  const visible = hidden > 0 ? lines.slice(hidden) : lines;
  // Truncate long individual lines so borders don't break.
  const contentWidth = Math.max(20, Math.min(termWidth - 4, 100));

  return (
    <Box flexDirection="column" marginTop={0}>
      {/* Header */}
      <Box flexDirection="row">
        <Text color={theme.warn}>◆ </Text>
        <Text bold color={theme.tool}>
          {name}
        </Text>
        <Text dimColor>{`  ⏱ ${fmtDuration(elapsedMs)}`}</Text>
        {hidden > 0 ? (
          <Text dimColor>{`  (${totalLines} lines, showing last ${MAX_STREAM_LINES})`}</Text>
        ) : null}
      </Box>
      {/* Output lines */}
      <Box flexDirection="column" marginLeft={2}>
        {hidden > 0 ? (
          <Text dimColor italic>{`  … ${hidden} more line${hidden === 1 ? '' : 's'} above`}</Text>
        ) : null}
        {visible.map((line, i) => {
          const key = i;
          const trimmed = line.length > contentWidth ? `${line.slice(0, contentWidth - 1)}…` : line;
          return (
            <Text key={key} dimColor>
              {trimmed || ' '}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
});

export function tailForDisplay(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.length - maxChars;
  // Prefer a newline boundary near the cut for a cleaner visual edge.
  const nl = text.indexOf('\n', cut);
  if (nl !== -1 && nl < cut + 80) {
    return `… ${text.slice(nl + 1)}`;
  }
  return `… ${text.slice(cut)}`;
}

function DiffBlock({ rows, hidden }: { rows: DiffLineRow[]; hidden: number }): React.ReactElement {
  // Width of the line-number gutter: pick the widest line number across all
  // rows so the column stays aligned. Fall back to 1 when no row carries a
  // line number (e.g. a diff with only a meta/hunk row).
  let gutterWidth = 1;
  for (const r of rows) {
    const n = r.kind === 'del' ? r.oldLine : r.newLine;
    if (typeof n === 'number') {
      const w = String(n).length;
      if (w > gutterWidth) gutterWidth = w;
    }
  }
  const blank = ' '.repeat(gutterWidth);
  return (
    <Box flexDirection="column" marginLeft={4} marginTop={0}>
      {rows.map((row, i) => {
        const key = i;
        if (row.kind === 'hunk') {
          return (
            <Text key={key} color="cyan" dimColor>
              {row.text}
            </Text>
          );
        }
        if (row.kind === 'meta') {
          return (
            <Text key={key} dimColor>
              {`${blank}  ${row.text}`}
            </Text>
          );
        }
        const lnNumber = row.kind === 'del' ? row.oldLine : row.newLine;
        const lnText =
          typeof lnNumber === 'number' ? String(lnNumber).padStart(gutterWidth, ' ') : blank;
        if (row.kind === 'ctx') {
          return (
            <Text key={key} dimColor>
              {`${lnText}  ${row.text}`}
            </Text>
          );
        }
        // add / del — soft background block on the content only; line number
        // stays dim outside the block so the eye anchors on the change, not
        // a wall of colour. Bright variants render lighter than plain
        // green/red on most terminals.
        const bg = row.kind === 'add' ? theme.diffAddBg : theme.diffDelBg;
        return (
          <Text key={key}>
            <Text dimColor>{`${lnText}  `}</Text>
            <Text backgroundColor={bg} color="black">
              {row.text}
            </Text>
          </Text>
        );
      })}
      {hidden > 0 ? (
        <Text dimColor italic>
          {`${blank}  … ${hidden} more line${hidden === 1 ? '' : 's'}`}
        </Text>
      ) : null}
    </Box>
  );
}

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

export const Entry = React.memo(function Entry({
  entry,
  termWidth,
}: { entry: HistoryEntry; termWidth: number }): React.ReactElement {
  switch (entry.kind) {
    case 'user':
      return (
        <Box
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
      // Subtract the panel's left-border + paddingLeft chrome from the
      // terminal width so the body lays out inside the box, not against
      // the full terminal. Tables in particular will overflow otherwise
      // (see assistantContentWidth).
      const contentWidth = assistantContentWidth(termWidth);
      return (
        <Box
          flexDirection="column"
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
          <AssistantBody text={entry.text} termWidth={termWidth} contentWidth={contentWidth} />
        </Box>
      );
    }
    case 'tool': {
      const argSummary = formatToolArgs(entry.name, entry.input);
      const outLines = formatToolOutput(
        entry.name,
        entry.output,
        entry.ok,
        entry.outputBytes,
        entry.outputLines,
      );
      const diff = entry.ok ? extractDiffPreview(entry.name, entry.output) : undefined;
      // Right-aligned size chip: what the MODEL actually received, not the
      // 400-char event preview. Lines (when meaningful), real bytes, and a
      // ~3.5 chars/token estimate. Skipped entirely on errors and empty
      // bodies so the success line stays clean.
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
            <Text color={entry.ok ? theme.success : theme.error}>{entry.ok ? '●' : '✗'}</Text>{' '}
            <Text bold color={theme.tool}>
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
          {outLines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: tool output lines are static, index is stable
            <Text key={i}>
              <Text dimColor>{i === outLines.length - 1 && !diff ? '  └─ ' : '  ├─ '}</Text>
              <Text
                color={!entry.ok || line.startsWith('!') ? 'red' : undefined}
                dimColor={entry.ok && !line.startsWith('!')}
              >
                {line}
              </Text>
            </Text>
          ))}
          {diff ? <DiffBlock rows={diff.rows} hidden={diff.hidden} /> : null}
        </Box>
      );
    }
    case 'info':
      return <Text dimColor>{entry.text}</Text>;
    case 'warn':
      return (
        <Box
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
      // Confirmation is handled by ConfirmPrompt component, not here.
      // This placeholder is intentionally minimal to avoid duplicating the UI.
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
      // One-line summary for tools/spawn/done; multi-line wrap for
      // assistant messages. The label color is stable per subagent so
      // the eye can track interleaved output from multiple agents.
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
            // biome-ignore lint/suspicious/noArrayIndexKey: stable line index
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

/**
 * Startup splash. Renders into the Static area on mount and never
 * re-renders, so it's safe to use rich layout without worrying about
 * Ink's redraw cursor math. Keeping it inside one Box (no nested
 * borders that pull in different widths per line) keeps the frame
 * intact at any terminal width ≥ 60 cols.
 */
function Banner({
  entry,
}: {
  entry: Extract<HistoryEntry, { kind: 'banner' }>;
}): React.ReactElement {
  const cwdShort = shortenPath(entry.cwd, 48);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={2} paddingY={0}>
      <Text>
        <Text color="magenta" bold>
          {'  ▟▛  '}
        </Text>
        <Text color="magenta" bold>
          WrongStack
        </Text>
        <Text dimColor>{'  v'}</Text>
        <Text>{entry.version}</Text>
      </Text>
      <Text dimColor italic>
        {'      Built on the wrong stack. Shipped anyway.'}
      </Text>
      <Text>
        <Text color="cyan">{'      provider  '}</Text>
        <Text>
          {entry.provider}/{entry.model}
        </Text>
      </Text>
      {entry.family ? (
        <Text>
          <Text color="cyan">{'      family    '}</Text>
          <Text dimColor>{entry.family}</Text>
        </Text>
      ) : null}
      {entry.keyTail ? (
        <Text>
          <Text color="cyan">{'      key       '}</Text>
          <Text dimColor>{'●●●…'}</Text>
          <Text>{entry.keyTail}</Text>
        </Text>
      ) : null}
      <Text>
        <Text color="cyan">{'      cwd       '}</Text>
        <Text dimColor>{cwdShort}</Text>
      </Text>
      <Text>
        <Text color="cyan">{'      hints     '}</Text>
        <Text dimColor>/help · /init · /memory · /queue · /exit</Text>
      </Text>
    </Box>
  );
}

export function shortenPath(p: string, max: number): string {
  if (p.length <= max) return p;
  // Keep the tail (closest to where the user is working).
  return `…${p.slice(p.length - (max - 1))}`;
}

const MAX_PREVIEW = 120;

export function previewArgs(input: unknown): string {
  let s: string;
  try {
    s = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    s = String(input);
  }
  return collapse(s, MAX_PREVIEW);
}

export function previewOutput(output: string): string {
  return collapse(output, MAX_PREVIEW);
}

function collapse(s: string, max: number): string {
  const oneLine = s.replace(/\r?\n/g, '↵').replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/** Compact thousands formatter used by the tool-size chip. 4500 → "4.5k",
 *  12000 → "12k", 1_500_000 → "1.5M". Keeps the chip from blowing out the
 *  status line when a tool dumps a megabyte of output. */
export function fmtTok(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.floor(ms / 1000);
  return `${Math.floor(totalSec / 60)}m${totalSec % 60}s`;
}

const ARG_BUDGET = 60;
const OUT_BUDGET = 80;

/**
 * Render the most useful single-line description of a tool call's
 * arguments. Each tool has the field a human cares about (path for
 * read/edit, command for bash, pattern for grep) — pick that and skip
 * the noisy JSON shape entirely. Falls back to a compact JSON preview
 * for unrecognised tools.
 */
export function formatToolArgs(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;

  switch (toolName) {
    case 'read':
    case 'write':
    case 'edit':
    case 'patch':
    case 'document':
    case 'list_dir':
    case 'ls':
    case 'tree': {
      const p = stringOf(obj['path']) ?? stringOf(obj['file']);
      return p ? shortenPath(p, ARG_BUDGET) : '';
    }
    case 'grep':
    case 'search':
    case 'replace': {
      const pat = stringOf(obj['pattern']) ?? stringOf(obj['query']);
      const scope = stringOf(obj['path']) ?? stringOf(obj['glob']);
      const head = pat ? `"${truncMid(pat, 36)}"` : '';
      const tail = scope ? ` in ${shortenPath(scope, 28)}` : '';
      return `${head}${tail}` || (stringOf(obj['command']) ?? '');
    }
    case 'glob': {
      const pat = stringOf(obj['pattern']) ?? stringOf(obj['glob']);
      return pat ? `"${truncMid(pat, ARG_BUDGET - 2)}"` : '';
    }
    case 'bash':
    case 'shell':
    case 'exec':
    case 'install':
    case 'git': {
      const cmd = stringOf(obj['command']) ?? stringOf(obj['args']);
      return cmd ? truncMid(cmd, ARG_BUDGET) : '';
    }
    case 'diff': {
      const files = Array.isArray(obj['files']) ? (obj['files'] as unknown[]) : undefined;
      if (files && files.length > 0) {
        const head = stringOf(files[0]) ?? '';
        const rest = files.length > 1 ? ` (+${files.length - 1})` : '';
        return head ? `${shortenPath(head, 50)}${rest}` : '';
      }
      const mode = stringOf(obj['mode']);
      return mode ? `mode: ${mode}` : '';
    }
    case 'fetch':
    case 'webfetch':
    case 'web_fetch': {
      const u = stringOf(obj['url']);
      return u ? truncMid(u, ARG_BUDGET) : '';
    }
    case 'todo': {
      const list = obj['todos'];
      if (Array.isArray(list)) return `${list.length} item${list.length === 1 ? '' : 's'}`;
      return '';
    }
    case 'lint':
    case 'format':
    case 'typecheck':
    case 'test':
    case 'audit':
    case 'outdated': {
      const files = obj['files'];
      if (Array.isArray(files) && files.length > 0) {
        const first = stringOf(files[0]);
        const more = files.length > 1 ? ` (+${files.length - 1})` : '';
        return first ? `${shortenPath(first, 50)}${more}` : `${files.length} files`;
      }
      const filter = stringOf(obj['filter']) ?? stringOf(obj['pattern']);
      return filter ? `"${truncMid(filter, ARG_BUDGET - 2)}"` : '';
    }
    case 'json': {
      const file = stringOf(obj['file']);
      const q = stringOf(obj['query']);
      if (file) return q ? `${shortenPath(file, 40)}  ${q}` : shortenPath(file, ARG_BUDGET);
      return q ? truncMid(q, ARG_BUDGET) : '';
    }
    case 'scaffold': {
      const tmpl = stringOf(obj['template']) ?? stringOf(obj['type']);
      const name = stringOf(obj['name']);
      if (tmpl && name) return `${tmpl} → ${truncMid(name, ARG_BUDGET - tmpl.length - 4)}`;
      return name ?? tmpl ?? '';
    }
    case 'remember':
    case 'forget':
    case 'memory': {
      const key = stringOf(obj['key']) ?? stringOf(obj['name']);
      return key ? truncMid(key, ARG_BUDGET) : '';
    }
    case 'mode': {
      const m = stringOf(obj['mode']) ?? stringOf(obj['name']);
      return m ? truncMid(m, ARG_BUDGET) : '';
    }
    case 'logs': {
      const target = stringOf(obj['target']) ?? stringOf(obj['service']) ?? stringOf(obj['path']);
      return target ? truncMid(target, ARG_BUDGET) : '';
    }
  }

  // Generic fallback: prefer the most "identifying" string field, else
  // a tight JSON preview.
  for (const key of ['path', 'file', 'url', 'name', 'query', 'pattern', 'command']) {
    const v = stringOf(obj[key]);
    if (v) return truncMid(v, ARG_BUDGET);
  }
  try {
    return truncMid(JSON.stringify(obj), ARG_BUDGET);
  } catch {
    return '';
  }
}

/**
 * Distil a tool's result text into 0–N digest lines the renderer can
 * stack under the tool header. Some tools say everything in one line
 * (todo: nothing to add beyond the args); others (bash with both
 * stdout and stderr, grep with a first matching path) deserve two or
 * three. The shape is per-tool — there is no fixed budget.
 */
export function formatToolOutput(
  toolName: string,
  output: string | undefined,
  ok: boolean,
  /** Real bytes the model received — passed in by the Entry component so
   *  read-tool / shell-tool digests can quote the true size instead of the
   *  400-char preview that `output` is capped to. */
  _outputBytes?: number,
  /** Real line count from the agent — preferred over scanning the preview
   *  when present, since the preview rarely contains every prefix. */
  outputLines?: number,
): string[] {
  if (!output) return ok ? [] : ['failed'];
  const text = output.trim();
  if (!text) return ok ? [] : ['failed'];

  // Try to parse JSON-shaped tool outputs (grep, glob, etc.).
  const json = tryParseJson(text);

  if (toolName === 'write') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const bytes = numOf(o['bytes_written']) ?? numOf(o['bytes']);
      const created = o['created'] === true;
      const tag = created ? 'created' : 'updated';
      if (bytes !== undefined) return [`${tag} · ${fmtBytes(bytes)}`];
      return [tag];
    }
  }

  if (toolName === 'edit') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const reps = numOf(o['replacements']);
      if (reps !== undefined) return [`${reps} replacement${reps === 1 ? '' : 's'}`];
    }
  }

  if (toolName === 'patch') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const applied = numOf(o['applied']);
      const rejected = numOf(o['rejected']);
      const files = Array.isArray(o['files']) ? (o['files'] as unknown[]) : undefined;
      const lines: string[] = [];
      if (applied !== undefined || rejected !== undefined) {
        const parts = [];
        if (applied !== undefined) parts.push(`${applied} applied`);
        if (rejected !== undefined && rejected > 0) parts.push(`${rejected} rejected`);
        lines.push(parts.join(' · '));
      }
      if (files && files.length > 0) {
        const first = stringOf(files[0]) ?? '';
        const more = files.length > 1 ? ` (+${files.length - 1})` : '';
        lines.push(`${shortenPath(first, 60)}${more}`);
      }
      if (lines.length > 0) return lines;
    }
  }

  if (toolName === 'replace') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const files = numOf(o['files_modified']);
      const reps = numOf(o['total_replacements']);
      if (files !== undefined && reps !== undefined) {
        return [
          `${reps} replacement${reps === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}`,
        ];
      }
    }
  }

  if (toolName === 'diff') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const files = Array.isArray(o['files']) ? (o['files'] as unknown[]) : undefined;
      const truncated = o['truncated'] === true;
      const mode = stringOf(o['mode']);
      const diff = stringOf(o['diff']);
      if (!diff) return [files && files.length === 0 ? 'no changes' : 'empty diff'];
      const head: string[] = [];
      if (mode) head.push(mode);
      if (files && files.length > 0)
        head.push(`${files.length} file${files.length === 1 ? '' : 's'}`);
      if (truncated) head.push('truncated');
      return head.length > 0 ? [head.join(' · ')] : [];
    }
  }

  if (toolName === 'read') {
    // When the agent supplied a real line count (new path), the size chip
    // beside the tool header already shows lines/bytes/tokens for the FULL
    // body the model received — no need to repeat misleading numbers
    // derived from the 400-char preview.
    if (outputLines !== undefined) return [];
    // Legacy fallback: derive what we can from the preview text. The byte
    // count below is the preview length, NOT what the model received, so
    // mark it as such to avoid confusion.
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const bytes = numOf(o['bytes']);
      if (bytes !== undefined) return [`${fmtBytes(bytes)} read`];
    }
    const range = scanNumberedRange(text);
    if (range.count > 0 && range.first !== undefined && range.last !== undefined) {
      if (range.first === range.last) {
        return [`L${range.first} · ${fmtBytes(text.length)}`];
      }
      const contiguous = range.count === range.last - range.first + 1;
      const head = `L${range.first}–${range.last}`;
      const tail = contiguous
        ? `${range.count} line${range.count === 1 ? '' : 's'}`
        : `${range.count} lines (gaps)`;
      return [`${head} · ${tail} · ${fmtBytes(text.length)}`];
    }
  }

  if (toolName === 'grep' || toolName === 'glob') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const matches = Array.isArray(o['matches']) ? (o['matches'] as unknown[]) : undefined;
      const count = numOf(o['count']) ?? matches?.length;
      const truncated = o['truncated'] === true;
      if (count !== undefined) {
        if (count === 0) return ['no matches'];
        const lines: string[] = [
          `${count} match${count === 1 ? '' : 'es'}${truncated ? ' (truncated)' : ''}`,
        ];
        // Surface the first hit so the user knows *where* without
        // opening the tool result.
        const firstHit = matches && matches.length > 0 ? formatMatchHit(matches[0]) : undefined;
        if (firstHit) lines.push(firstHit);
        return lines;
      }
    }
  }

  if (toolName === 'bash' || toolName === 'shell') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const exit = numOf(o['exit_code']) ?? numOf(o['exitCode']);
      const stdout = stringOf(o['stdout']) ?? '';
      const stderr = stringOf(o['stderr']) ?? '';
      const stdoutLines = countLines(stdout);
      const stderrLines = countLines(stderr);
      const head: string[] = [];
      if (exit !== undefined) head.push(`exit ${exit}`);
      const lineParts: string[] = [];
      if (stdoutLines > 0) lineParts.push(`${stdoutLines} out`);
      if (stderrLines > 0) lineParts.push(`${stderrLines} err`);
      if (lineParts.length > 0) head.push(lineParts.join(' · '));
      const lines: string[] = [];
      if (head.length > 0) lines.push(head.join(' · '));
      const stdoutPreview = firstNonEmpty(stdout);
      const stderrPreview = firstNonEmpty(stderr);
      if (stdoutPreview) lines.push(`"${truncMid(stdoutPreview, 70)}"`);
      if (stderrPreview && stderrPreview !== stdoutPreview) {
        lines.push(`! "${truncMid(stderrPreview, 70)}"`);
      }
      if (lines.length > 0) return lines;
    }
  }

  if (toolName === 'todo') {
    // The arg summary already says "N items" — repeating "updated" is
    // noise, so emit nothing on success.
    return ok ? [] : [text.split('\n')[0] ?? ''];
  }

  if (toolName === 'fetch' || toolName === 'webfetch' || toolName === 'web_fetch') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const status = numOf(o['status']);
      const ct = stringOf(o['content_type']);
      const url = stringOf(o['url']);
      const content = stringOf(o['content']);
      const head: string[] = [];
      if (status !== undefined) head.push(`HTTP ${status}`);
      if (ct) head.push(ct.split(';')[0] ?? ct);
      if (content) head.push(fmtBytes(Buffer.byteLength(content, 'utf8')));
      const lines: string[] = [];
      if (head.length > 0) lines.push(head.join(' · '));
      if (url && status !== undefined && (status < 200 || status >= 400)) {
        lines.push(shortenPath(url, 70));
      }
      if (lines.length > 0) return lines;
    }
  }

  if (toolName === 'git') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const exit = numOf(o['exitCode']) ?? numOf(o['exit_code']);
      const stdout = stringOf(o['stdout']) ?? '';
      const stderr = stringOf(o['stderr']) ?? '';
      const head: string[] = [];
      if (exit !== undefined) head.push(`exit ${exit}`);
      const stdoutLines = countLines(stdout);
      const stderrLines = countLines(stderr);
      const lparts: string[] = [];
      if (stdoutLines > 0) lparts.push(`${stdoutLines} out`);
      if (stderrLines > 0) lparts.push(`${stderrLines} err`);
      if (lparts.length > 0) head.push(lparts.join(' · '));
      const lines: string[] = [];
      if (head.length > 0) lines.push(head.join(' · '));
      const preview = firstNonEmpty(stdout) ?? firstNonEmpty(stderr);
      if (preview) lines.push(`"${truncMid(preview, 70)}"`);
      if (lines.length > 0) return lines;
    }
  }

  if (toolName === 'lint') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const linter = stringOf(o['linter']);
      const files = numOf(o['files_checked']);
      const errors = numOf(o['errors']) ?? 0;
      const warnings = numOf(o['warnings']) ?? 0;
      const fix = o['fix_applied'] === true;
      const head: string[] = [];
      if (linter && linter !== 'none') head.push(linter);
      head.push(`${errors} error${errors === 1 ? '' : 's'}`);
      head.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
      if (files !== undefined) head.push(`${files} file${files === 1 ? '' : 's'}`);
      if (fix) head.push('fixed');
      return [head.join(' · ')];
    }
  }

  if (toolName === 'format') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const fixer = stringOf(o['fixer']);
      const checked = numOf(o['files_checked']);
      const changed = numOf(o['files_changed']);
      const head: string[] = [];
      if (fixer && fixer !== 'none') head.push(fixer);
      if (changed !== undefined && checked !== undefined) {
        head.push(`${changed}/${checked} changed`);
      } else if (changed !== undefined) {
        head.push(`${changed} changed`);
      }
      return head.length > 0 ? [head.join(' · ')] : [];
    }
  }

  if (toolName === 'typecheck') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const exit = numOf(o['exit_code']) ?? numOf(o['exitCode']);
      const errors = numOf(o['errors']);
      const head: string[] = [];
      if (errors !== undefined) head.push(`${errors} error${errors === 1 ? '' : 's'}`);
      if (exit !== undefined) head.push(`exit ${exit}`);
      const stdout = stringOf(o['output']) ?? stringOf(o['stdout']) ?? '';
      const lines: string[] = [];
      if (head.length > 0) lines.push(head.join(' · '));
      const preview = firstNonEmpty(stdout);
      if (preview && (!errors || errors > 0)) lines.push(`"${truncMid(preview, 70)}"`);
      if (lines.length > 0) return lines;
    }
  }

  if (toolName === 'test') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const runner = stringOf(o['runner']);
      const total = numOf(o['tests_run']) ?? 0;
      const passed = numOf(o['passed']) ?? 0;
      const failed = numOf(o['failed']) ?? 0;
      const duration = numOf(o['duration_ms']);
      const head: string[] = [];
      if (runner && runner !== 'none') head.push(runner);
      head.push(`${passed}/${total} passed`);
      if (failed > 0) head.push(`${failed} failed`);
      if (duration !== undefined) head.push(fmtDuration(duration));
      return [head.join(' · ')];
    }
  }

  if (toolName === 'audit') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const total = numOf(o['total']) ?? 0;
      const summary = stringOf(o['summary']);
      if (total === 0) return ['no vulnerabilities'];
      const head = `${total} vulnerabilit${total === 1 ? 'y' : 'ies'}`;
      return summary && summary.toLowerCase() !== head.toLowerCase()
        ? [head, truncMid(summary, OUT_BUDGET)]
        : [head];
    }
  }

  if (toolName === 'outdated') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const total = numOf(o['total']) ?? 0;
      const pkgs = Array.isArray(o['packages']) ? (o['packages'] as unknown[]) : undefined;
      if (total === 0) return ['all up to date'];
      const lines: string[] = [`${total} outdated`];
      if (pkgs && pkgs.length > 0) {
        const first = pkgs[0];
        if (first && typeof first === 'object') {
          const p = first as Record<string, unknown>;
          const name = stringOf(p['name']) ?? stringOf(p['package']);
          const cur = stringOf(p['current']);
          const wanted = stringOf(p['wanted']) ?? stringOf(p['latest']);
          if (name && cur && wanted) lines.push(`${name}: ${cur} → ${wanted}`);
          else if (name) lines.push(name);
        }
      }
      return lines;
    }
  }

  if (toolName === 'tree') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const files = numOf(o['total_files']);
      const dirs = numOf(o['total_dirs']);
      const truncated = o['truncated'] === true;
      const parts: string[] = [];
      if (files !== undefined) parts.push(`${files} file${files === 1 ? '' : 's'}`);
      if (dirs !== undefined) parts.push(`${dirs} dir${dirs === 1 ? '' : 's'}`);
      if (truncated) parts.push('truncated');
      return parts.length > 0 ? [parts.join(' · ')] : [];
    }
  }

  if (toolName === 'json') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const err = stringOf(o['error']);
      if (err) return [truncMid(err, OUT_BUDGET)];
      const type = stringOf(o['type']);
      const keys = Array.isArray(o['keys']) ? (o['keys'] as unknown[]) : undefined;
      const parts: string[] = [];
      if (type) parts.push(type);
      if (keys) parts.push(`${keys.length} key${keys.length === 1 ? '' : 's'}`);
      return parts.length > 0 ? [parts.join(' · ')] : [];
    }
  }

  if (toolName === 'install') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const exit = numOf(o['exit_code']) ?? numOf(o['exitCode']);
      const added = numOf(o['added']);
      const removed = numOf(o['removed']);
      const head: string[] = [];
      if (exit !== undefined) head.push(`exit ${exit}`);
      if (added !== undefined) head.push(`+${added}`);
      if (removed !== undefined) head.push(`-${removed}`);
      const stdout = stringOf(o['stdout']) ?? stringOf(o['output']) ?? '';
      const lines: string[] = [];
      if (head.length > 0) lines.push(head.join(' · '));
      const preview = firstNonEmpty(stdout);
      if (preview) lines.push(`"${truncMid(preview, 70)}"`);
      if (lines.length > 0) return lines;
    }
  }

  if (toolName === 'scaffold') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const created = Array.isArray(o['created']) ? (o['created'] as unknown[]) : undefined;
      const skipped = Array.isArray(o['skipped']) ? (o['skipped'] as unknown[]) : undefined;
      const parts: string[] = [];
      if (created !== undefined) parts.push(`${created.length} created`);
      if (skipped !== undefined && skipped.length > 0) parts.push(`${skipped.length} skipped`);
      if (parts.length > 0) return [parts.join(' · ')];
    }
  }

  if (toolName === 'remember' || toolName === 'forget' || toolName === 'memory') {
    return ok ? [toolName === 'forget' ? 'removed' : 'saved'] : [text.split('\n')[0] ?? ''];
  }

  if (toolName === 'mode') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const mode = stringOf(o['mode']) ?? stringOf(o['active']) ?? stringOf(o['name']);
      if (mode) return [`mode: ${mode}`];
    }
  }

  if (toolName === 'search') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const matches = Array.isArray(o['matches'])
        ? (o['matches'] as unknown[])
        : Array.isArray(o['results'])
          ? (o['results'] as unknown[])
          : undefined;
      const count = numOf(o['count']) ?? matches?.length;
      if (count !== undefined) {
        if (count === 0) return ['no results'];
        const lines: string[] = [`${count} result${count === 1 ? '' : 's'}`];
        const firstHit = matches && matches.length > 0 ? formatMatchHit(matches[0]) : undefined;
        if (firstHit) lines.push(firstHit);
        return lines;
      }
    }
  }

  if (toolName === 'logs') {
    const lines = text.split('\n').filter((l) => l.trim());
    if (lines.length === 0) return [];
    const head = `${lines.length} line${lines.length === 1 ? '' : 's'}`;
    const lastLine = lines[lines.length - 1];
    return lastLine ? [head, `"${truncMid(lastLine.trim(), 70)}"`] : [head];
  }

  // Generic fallback.
  //
  // Earlier we just grabbed the first non-empty line. That broke
  // catastrophically for tools that return pretty-printed JSON (most
  // notably `delegate`): `JSON.stringify(obj, null, 2)` starts with a
  // bare `{` on line 1, so the preview rendered as `└─ {` and the
  // user couldn't see WHY the subagent finished — defeating the whole
  // point of the chip.
  //
  // New behavior:
  // 1. If the text parses as a JSON object, surface up to GENERIC_KV_KEYS
  //    of its most informative keys inline (`ok=false · status=timeout
  //    · iterations=12 · error="..."`).
  // 2. Otherwise collapse ALL whitespace into single spaces (no more
  //    "first line only" trap) and render up to GENERIC_BUDGET chars.
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const summary = summarizeJsonObject(json as Record<string, unknown>);
    if (summary) return [summary];
  }
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return [truncMid(collapsed, GENERIC_BUDGET)];
}

const GENERIC_BUDGET = 240;

/**
 * Build a one-line "key=value · key=value …" preview for a JSON-shaped
 * tool result. Prioritises fields the user cares about: status flags,
 * error/result fields, then everything else by appearance order. Stops
 * once the rendered preview hits the budget.
 */
function summarizeJsonObject(obj: Record<string, unknown>): string | null {
  const keys = Object.keys(obj);
  if (keys.length === 0) return null;
  // Reorder: status-y keys first (so a failure/timeout reads obviously),
  // then narrative fields (result/error/message), then the rest.
  const priority = [
    'ok',
    'status',
    'timedOut',
    'stopReason',
    'reason',
    'error',
    'message',
    'result',
    'summary',
    'iterations',
    'toolCalls',
    'durationMs',
    'subagentId',
    'taskId',
  ];
  const ordered = [
    ...priority.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !priority.includes(k)),
  ];
  const parts: string[] = [];
  let used = 0;
  for (const key of ordered) {
    const v = obj[key];
    if (v === undefined || v === null) continue;
    const rendered =
      typeof v === 'string'
        ? `${key}="${truncMid(v.replace(/\s+/g, ' '), 80)}"`
        : typeof v === 'number' || typeof v === 'boolean'
          ? `${key}=${v}`
          : Array.isArray(v)
            ? `${key}=[${v.length}]`
            : `${key}={…}`;
    if (used + rendered.length > GENERIC_BUDGET) {
      parts.push('…');
      break;
    }
    parts.push(rendered);
    used += rendered.length + 3; // " · " separator
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function firstNonEmpty(text: string): string | undefined {
  if (!text) return undefined;
  const line = text.split('\n').find((l) => l.trim());
  return line ? line.replace(/\s+/g, ' ').trim() : undefined;
}

function formatMatchHit(hit: unknown): string | undefined {
  if (typeof hit === 'string') return truncMid(hit, 70);
  if (hit && typeof hit === 'object') {
    const o = hit as Record<string, unknown>;
    const file = stringOf(o['file']) ?? stringOf(o['path']);
    const line = numOf(o['line']) ?? numOf(o['lineNumber']);
    const snippet = stringOf(o['text']) ?? stringOf(o['match']) ?? stringOf(o['preview']);
    if (file) {
      const head = line !== undefined ? `${shortenPath(file, 40)}:${line}` : shortenPath(file, 50);
      return snippet ? `${head}  ${truncMid(snippet.replace(/\s+/g, ' '), 40)}` : head;
    }
    if (snippet) return truncMid(snippet, 70);
  }
  return undefined;
}

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'ctx' | 'meta';

export interface DiffLineRow {
  kind: DiffLineKind;
  text: string;
  oldLine?: number;
  newLine?: number;
}

const DIFF_MAX_LINES = 8;

/**
 * Pull a unified-diff string out of a tool's JSON output, then turn it
 * into a small, structured preview suitable for colour-coded rendering
 * in the TUI history. We cap at ~8 lines so a giant patch doesn't
 * dominate the chat scrollback; the renderer surfaces the hidden count.
 */
export function extractDiffPreview(
  toolName: string,
  output: string | undefined,
): { rows: DiffLineRow[]; hidden: number } | undefined {
  if (!output) return undefined;
  const text = output.trim();
  if (!text) return undefined;

  let diff: string | undefined;
  if (toolName === 'edit' || toolName === 'diff') {
    const parsed = tryParseJson(text);
    if (parsed && typeof parsed === 'object') {
      diff = stringOf((parsed as Record<string, unknown>)['diff']);
    }
  } else if (toolName === 'patch') {
    const parsed = tryParseJson(text);
    if (parsed && typeof parsed === 'object') {
      diff =
        stringOf((parsed as Record<string, unknown>)['diff']) ??
        stringOf((parsed as Record<string, unknown>)['stdout']);
    } else if (text.includes('@@') || text.startsWith('---')) {
      diff = text;
    }
  }

  if (!diff || !diff.trim() || diff.startsWith('(no-op')) return undefined;
  return parseUnifiedDiff(diff, DIFF_MAX_LINES);
}

function parseUnifiedDiff(diff: string, maxLines: number): { rows: DiffLineRow[]; hidden: number } {
  const all: DiffLineRow[] = [];
  // Counters advance as we walk through a hunk so each row can carry its
  // line number in the source/target file. Reset whenever we see a new @@.
  let oldLn = 0;
  let newLn = 0;
  for (const raw of diff.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('diff --git') || line.startsWith('index ')) continue;
    if (line.startsWith('@@')) {
      const m = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      if (m) {
        oldLn = Number.parseInt(m[1] ?? '0', 10) || 0;
        newLn = Number.parseInt(m[2] ?? '0', 10) || 0;
      }
      all.push({ kind: 'hunk', text: truncMid(line, 60) });
      continue;
    }
    if (line.startsWith('+')) {
      all.push({ kind: 'add', text: truncMid(line, 100), newLine: newLn });
      newLn++;
      continue;
    }
    if (line.startsWith('-')) {
      all.push({ kind: 'del', text: truncMid(line, 100), oldLine: oldLn });
      oldLn++;
      continue;
    }
    if (line.startsWith('\\ No newline')) {
      all.push({ kind: 'meta', text: line });
      continue;
    }
    if (line.length === 0) continue;
    all.push({ kind: 'ctx', text: truncMid(line, 100), oldLine: oldLn, newLine: newLn });
    oldLn++;
    newLn++;
  }
  if (all.length === 0) return { rows: [], hidden: 0 };
  if (all.length <= maxLines) return { rows: all, hidden: 0 };
  return { rows: all.slice(0, maxLines), hidden: all.length - maxLines };
}

function stringOf(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function numOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function tryParseJson(s: string): unknown {
  const t = s.trimStart();
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function scanNumberedRange(text: string): { first?: number; last?: number; count: number } {
  let first: number | undefined;
  let last: number | undefined;
  let count = 0;
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)→/);
    if (m?.[1]) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n)) {
        if (first === undefined) first = n;
        last = n;
        count++;
      }
    }
  }
  return { first, last, count };
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.replace(/\n$/, '').split('\n').length;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function truncMid(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
