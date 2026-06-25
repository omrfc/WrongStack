import { Box, Text } from '../../ink.js';
import type React from 'react';
import { type HLState, type Lang, highlightLine } from '../../highlight.js';
import { theme } from '../../theme.js';
import { stringOf, truncMid, tryParseJson } from './utils.js';

// ── Types ──

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'ctx' | 'meta';

export interface DiffLineRow {
  kind: DiffLineKind;
  text: string;
  oldLine?: number | undefined;
  newLine?: number | undefined;
}

export interface DiffPreview {
  rows: DiffLineRow[];
  hidden: number;
  added: number;
  removed: number;
  hiddenAdded: number;
  hiddenRemoved: number;
}

// ── Constants ──

/** Max code-block lines rendered before a "+N more" footer. */
export const MAX_CODE_LINES = 80;
const DIFF_MAX_LINES = 12;

// ── CodeBlock ──

/** Syntax-highlighted, framed code block. */
export function CodeBlock({
  code,
  lang,
  contentWidth,
}: { code: string; lang: Lang; contentWidth: number }): React.ReactElement {
  let lines = code.replace(/\n+$/, '').split('\n');
  const hidden = Math.max(0, lines.length - MAX_CODE_LINES);
  if (hidden > 0) lines = lines.slice(0, MAX_CODE_LINES);
  const gutterW = String(lines.length).length;
  // Pin the box to a deterministic width instead of letting Ink stretch it.
  // The box carries marginLeft 2 + round border (1 each side) + paddingX 1 each
  // side. Yoga's stretch does NOT subtract this marginLeft from the stretched
  // width, so the box would grow `contentWidth` wide and then sit 2 cols past
  // its container — the right border wraps to the next line's left edge (the
  // "boxes overflow / extra chars on the next line" bug). An explicit width
  // makes the box exactly fill the panel's inner area (100%) and never wrap.
  const boxWidth = Math.max(22, contentWidth - 2);
  // Text area inside the frame: box width − border(2) − paddingX(2) − gutter.
  const maxW = Math.max(20, Math.min(boxWidth - 4 - gutterW - 1, 120));
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
      width={boxWidth}
      flexShrink={0}
      marginLeft={2}
      marginY={0}
      borderStyle="round"
      borderColor={theme.borderDefault}
      paddingX={1}
    >
      {lang !== 'plain' ? <Text dimColor>{lang}</Text> : null}
      {rows.map((tokens, i) => (
        <Text key={i}>
          <Text dimColor>{`${String(i + 1).padStart(gutterW, ' ')} `}</Text>
          {tokens.length === 0
            ? ' '
            : tokens.map((t, j) => (
                <Text
                  key={j}
                  dimColor={Boolean(t.dim)}
                  bold={Boolean(t.bold)}
                  {...(t.color ? { color: t.color } : {})}
                >
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

// ── DiffBlock ──

export function DiffBlock({
  rows,
  hidden,
  hiddenAdded = 0,
  hiddenRemoved = 0,
}: {
  rows: DiffLineRow[];
  hidden: number;
  hiddenAdded?: number | undefined;
  hiddenRemoved?: number | undefined;
}): React.ReactElement {
  let gutterWidth = 1;
  for (const r of rows) {
    for (const n of [r.oldLine, r.newLine]) {
      if (typeof n === 'number') {
        const w = String(n).length;
        if (w > gutterWidth) gutterWidth = w;
      }
    }
  }
  const blank = ' '.repeat(gutterWidth);
  const gutterPad = `${blank} ${blank}`;
  const footerStats = [
    hiddenAdded > 0 ? `+${hiddenAdded}` : '',
    hiddenRemoved > 0 ? `-${hiddenRemoved}` : '',
  ].filter(Boolean);

  const markerFor = (kind: DiffLineKind) => {
    if (kind === 'add') return '+';
    if (kind === 'del') return '-';
    return ' ';
  };

  const textForDisplay = (row: DiffLineRow) => {
    if ((row.kind === 'add' || row.kind === 'del' || row.kind === 'ctx') && row.text.length > 0) {
      return row.text.slice(1) || ' ';
    }
    return row.text || ' ';
  };

  return (
    <Box flexDirection="column" marginLeft={4} marginTop={0}>
      {rows.map((row, i) => {
        const key = i;
        if (row.kind === 'hunk') {
          return (
            <Text key={key} color="cyan" dimColor>
              {`${gutterPad}  ${row.text}`}
            </Text>
          );
        }
        if (row.kind === 'meta') {
          return (
            <Text key={key} dimColor>
              {`${gutterPad}  ${row.text}`}
            </Text>
          );
        }
        const oldLn =
          typeof row.oldLine === 'number' ? String(row.oldLine).padStart(gutterWidth, ' ') : blank;
        const newLn =
          typeof row.newLine === 'number' ? String(row.newLine).padStart(gutterWidth, ' ') : blank;
        if (row.kind === 'ctx') {
          return (
            <Text key={key} dimColor>
              {`${oldLn} ${newLn}   ${textForDisplay(row)}`}
            </Text>
          );
        }
        const bg = row.kind === 'add' ? theme.diffAddBg : theme.diffDelBg;
        const lineColor = row.kind === 'add' ? theme.success : theme.error;
        const marker = markerFor(row.kind);
        return (
          <Text key={key}>
            <Text color={row.kind === 'del' ? lineColor : undefined} dimColor={row.kind !== 'del'}>
              {oldLn}
            </Text>
            <Text dimColor>{' '}</Text>
            <Text color={row.kind === 'add' ? lineColor : undefined} dimColor={row.kind !== 'add'}>
              {newLn}
            </Text>
            <Text>{' '}</Text>
            <Text color={lineColor} bold>
              {marker}
            </Text>
            <Text backgroundColor={bg} color="black">
              {textForDisplay(row)}
            </Text>
          </Text>
        );
      })}
      {hidden > 0 ? (
        <Text dimColor italic>
          {`${gutterPad}  … ${hidden} more line${hidden === 1 ? '' : 's'}${
            footerStats.length > 0 ? ` (${footerStats.join(' ')})` : ''
          }`}
        </Text>
      ) : null}
    </Box>
  );
}

// ── Diff parsing ──

export function parseUnifiedDiff(diff: string, maxLines: number): DiffPreview {
  const all: DiffLineRow[] = [];
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
  const added = all.filter((row) => row.kind === 'add').length;
  const removed = all.filter((row) => row.kind === 'del').length;
  if (all.length === 0) {
    return { rows: [], hidden: 0, added: 0, removed: 0, hiddenAdded: 0, hiddenRemoved: 0 };
  }
  if (all.length <= maxLines) {
    return { rows: all, hidden: 0, added, removed, hiddenAdded: 0, hiddenRemoved: 0 };
  }
  const rows = all.slice(0, maxLines);
  const hiddenRows = all.slice(maxLines);
  return {
    rows,
    hidden: hiddenRows.length,
    added,
    removed,
    hiddenAdded: hiddenRows.filter((row) => row.kind === 'add').length,
    hiddenRemoved: hiddenRows.filter((row) => row.kind === 'del').length,
  };
}

/**
 * Pull a unified-diff string out of a tool's JSON output, then turn it
 * into a small, structured preview suitable for colour-coded rendering.
 */
export function extractDiffPreview(
  toolName: string,
  output: string | undefined,
  input?: unknown | undefined,
): DiffPreview | undefined {
  if (!output) return undefined;
  const text = output.trim();
  if (!text) return undefined;

  let diff: string | undefined;
  if (toolName === 'edit' || toolName === 'diff' || toolName === 'write') {
    const parsed = tryParseJson(text);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      diff =
        toolName === 'write' && obj['created'] === true
          ? newFileDiffFromWriteInput(obj, input) ?? stringOf(obj['diff'])
          : stringOf(obj['diff']);
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
  } else if (toolName === 'replace') {
    const parsed = tryParseJson(text);
    if (parsed && typeof parsed === 'object') {
      diff = collectReplaceDiffs(parsed as Record<string, unknown>);
    }
  }

  if (!diff?.trim() || diff.startsWith('(no-op')) return undefined;
  const preview = parseUnifiedDiff(diff, DIFF_MAX_LINES);
  return preview.rows.length > 0 ? preview : undefined;
}

function collectReplaceDiffs(obj: Record<string, unknown>): string | undefined {
  const results = Array.isArray(obj['results']) ? (obj['results'] as unknown[]) : [];
  const diffs = results
    .map((result) =>
      result && typeof result === 'object'
        ? stringOf((result as Record<string, unknown>)['diff'])
        : undefined,
    )
    .filter((diff): diff is string => Boolean(diff?.trim()));
  return diffs.length > 0 ? diffs.join('\n') : undefined;
}

function newFileDiffFromWriteInput(
  output: Record<string, unknown>,
  input: unknown,
): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const content = stringOf(obj['content']);
  if (content === undefined) return undefined;
  const path = stringOf(output['path']) ?? stringOf(obj['path']) ?? 'new file';
  const lines = content === '' ? [] : content.replace(/\n$/, '').split('\n');
  const header = [`+++ ${path}`, `@@ -0,0 +1,${lines.length} @@`];
  return [...header, ...lines.map((line) => `+${line}`)].join('\n');
}
